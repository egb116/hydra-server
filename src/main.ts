/**
 * Composition root: config → database (legacy import + migrations) → deps →
 * modules → app → Bun.serve → jobs and workers → graceful shutdown.
 */
import { existsSync, statSync } from "node:fs";
import { ConfigError, type Env, loadConfig } from "./config";
import { backupDatabase, dailyBackupPath } from "./db/backup";
import { openDatabase } from "./db/connection";
import { buildApp } from "./http/app";
import { internalErrorBody } from "./http/middleware";
import { type Alerter, DiscordAlerter, noopAlerter } from "./lib/alert";
import { settleWithin } from "./lib/async";
import { systemClock } from "./lib/clock";
import { describeThrown } from "./lib/errors";
import { createOutboundFetch } from "./lib/http";
import { JobRunner } from "./lib/jobs";
import { createLogger } from "./lib/log";
import { createMetrics } from "./lib/metrics";
import { DAY_MS, HOUR_MS } from "./lib/time";
import { createModules } from "./modules";
import type { App, Deps, Module } from "./types";
import { SERVER_VERSION } from "./version";

/** Fly's kill_timeout is 30 s; finish well before it. */
const SHUTDOWN_DEADLINE_MS = 25_000;
const HTTP_DRAIN_MS = 10_000;
/** How long a crash waits for its Discord alert before shutting down. */
const ALERT_ON_CRASH_MS = 3_000;

export interface StartOptions {
  env: Env;
  /** Where JSON log lines go. Defaults to stdout. */
  logSink?: (line: string) => void;
}

export interface RunningServer {
  url: URL;
  deps: Deps;
  jobs: JobRunner;
  /** Stops HTTP, jobs and modules, then closes the database. Idempotent. */
  shutdown(reason: string): Promise<void>;
}

/**
 * Boots everything and returns a handle. Throws ConfigError on bad config.
 * main() adds process-level wiring (signals, exit codes) around it.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = loadConfig(options.env);
  const log = createLogger({
    level: config.logLevel,
    base: { service: "hydra-server" },
    ...(options.logSink ? { sink: options.logSink } : {}),
  });
  for (const warning of config.warnings) log.warn(warning);
  log.info("starting", { version: SERVER_VERSION, mode: config.mode, port: config.port });

  const clock = systemClock;
  const fetch = createOutboundFetch();
  const metrics = createMetrics();
  const alerter: Alerter = config.discordWebhookUrl
    ? new DiscordAlerter({ webhookUrl: config.discordWebhookUrl, fetch, clock, log })
    : noopAlerter;

  let conn: Awaited<ReturnType<typeof openDatabase>>;
  try {
    conn = await openDatabase(config.databasePath, { log, alerter, clock });
  } catch (err) {
    await reportBootFailure(err, { log, alerter, databasePath: config.databasePath });
    throw err;
  }
  const deps: Deps = {
    config,
    db: conn.db,
    sqlite: conn.sqlite,
    log,
    alerter,
    clock,
    fetch,
    metrics,
  };

  let modules: Module[];
  let app: App;
  const jobs = new JobRunner({ log, alerter, clock, metrics });
  try {
    modules = createModules(deps, { jobs });
    app = buildApp(deps, modules);

    // Daily single-file backup. Checked hourly so restarts don't keep pushing it back.
    const dailyPath = dailyBackupPath(config.databasePath);
    jobs.every(
      "db-daily-backup",
      HOUR_MS,
      () => {
        const age = existsSync(dailyPath) ? clock.now() - statSync(dailyPath).mtimeMs : Infinity;
        if (age < DAY_MS) return;
        const started = clock.now();
        backupDatabase(conn, dailyPath);
        log.info("daily backup written", { path: dailyPath, durationMs: clock.now() - started });
      },
      { runOnStart: true, jitterMs: 60_000 },
    );
    for (const module of modules) module.jobs?.(jobs);
  } catch (err) {
    conn.close();
    await reportBootFailure(err, { log, alerter, databasePath: config.databasePath });
    throw err;
  }

  const server = Bun.serve({
    port: config.port,
    // AI calls can take longer than Bun's default 10 s idle timeout.
    idleTimeout: 120,
    // Never serve Bun's HTML dev error page (it shows server paths), whatever NODE_ENV says.
    development: false,
    fetch: (req, srv) => app.fetch(req, { remoteAddr: srv.requestIP(req)?.address }),
    // Last resort: requestContext already turns every thrown value into a
    // response, so this only runs if the middleware itself fails.
    error: (err) => {
      log.error("unhandled server error", { err });
      metrics.inc("http.5xx");
      return Response.json(internalErrorBody(undefined), { status: 500 });
    },
  });
  log.info("listening", { url: server.url.toString() });

  for (const module of modules) await module.start?.();
  jobs.start();

  let stopping: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log.info("shutting down", { reason });
      // Stop accepting connections; let in-flight requests finish.
      const serverStopped = server.stop(false);
      await jobs.stopAll();
      for (const module of modules.toReversed()) {
        try {
          await module.stop?.();
        } catch (err) {
          log.error("module stop failed", { module: module.name, err });
        }
      }
      // Idle keep-alive connections would hold stop(false) open; cut them after a grace period.
      if (!(await settleWithin(serverStopped, HTTP_DRAIN_MS))) await server.stop(true);
      conn.close();
      log.info("stopped");
    })();
    return stopping;
  };

  return { url: server.url, deps, jobs, shutdown };
}

/**
 * A boot that fails after the config loaded (a corrupt or truncated database,
 * a failed migration, a disk error) exits 1 before the process handlers exist,
 * and Fly gives up restarting after a few tries. Say so first: logged, and
 * alerted (waiting at most ALERT_ON_CRASH_MS), with the backups to restore from.
 */
export async function reportBootFailure(
  err: unknown,
  ctx: { log: Pick<Deps["log"], "error">; alerter: Alerter; databasePath: string },
): Promise<void> {
  try {
    ctx.log.error("boot failed", { err });
  } catch {
    // The alert matters more than the log line.
  }
  const path = ctx.databasePath;
  const alerted = ctx.alerter
    .alert(
      "boot-failed",
      `Boot failed, the server is not running: ${describeThrown(err)}. ` +
        `Backups: ${dailyBackupPath(path)} (daily) and ${path}.pre-<migration>.bak ` +
        `(before each migration); see README "Backups".`,
    )
    .catch(() => {});
  await settleWithin(alerted, ALERT_ON_CRASH_MS);
}

async function main(): Promise<void> {
  let running: RunningServer;
  try {
    running = await startServer({ env: process.env });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}
`);
      process.exit(1);
    }
    throw err;
  }
  installProcessHandlers(running);
}

/**
 * Process-level wiring: an unhandled rejection is logged and alerted and the
 * server keeps running; an uncaught exception is logged, alerted (briefly
 * awaited) and followed by a graceful shutdown and exit 1; SIGTERM/SIGINT
 * shut down gracefully. No handler can throw (describeThrown never does).
 */
export function installProcessHandlers(
  running: Pick<RunningServer, "deps" | "shutdown">,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const { log, alerter } = running.deps;

  const stopAndExit = (reason: string, code: number): void => {
    const deadline = setTimeout(() => {
      log.error("shutdown deadline exceeded; exiting");
      exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    running.shutdown(reason).then(
      () => {
        clearTimeout(deadline);
        exit(code);
      },
      (err: unknown) => {
        clearTimeout(deadline);
        log.error("shutdown failed", { err });
        exit(1);
      },
    );
  };

  process.on("unhandledRejection", (reason) => {
    try {
      log.error("unhandled rejection", { err: reason });
      void alerter.alert("unhandled-rejection", `Unhandled rejection: ${describeThrown(reason)}`);
    } catch {
      // Logging must never take the process down.
    }
  });

  let crashing = false;
  process.on("uncaughtException", (err) => {
    if (crashing) return;
    crashing = true;
    try {
      log.error("uncaught exception; shutting down", { err });
    } catch {
      // Keep going: the shutdown matters more than the log line.
    }
    const alerted = alerter
      .alert("uncaught-exception", `Uncaught exception, restarting: ${describeThrown(err)}`)
      .catch(() => {});
    void settleWithin(alerted, ALERT_ON_CRASH_MS).then(() => stopAndExit("uncaughtException", 1));
  });

  process.on("SIGTERM", () => stopAndExit("SIGTERM", 0));
  process.on("SIGINT", () => stopAndExit("SIGINT", 0));
}

if (import.meta.main) await main();
