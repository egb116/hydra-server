import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, type Env, loadConfig } from "../../src/config";
import { type Conn, openDatabase } from "../../src/db/connection";
import type { Alerter } from "../../src/lib/alert";
import type { Clock } from "../../src/lib/clock";
import type { OutboundFetch, OutboundInit } from "../../src/lib/http";
import { createLogger, type Logger } from "../../src/lib/log";
import { createMetrics } from "../../src/lib/metrics";
import type { Deps } from "../../src/types";

export { legacyFixture, v1Encrypt, type LegacyFixture } from "./legacyFixture";

/** Awaits a promise that must reject and returns the error. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    return new Error(String(err));
  }
  throw new Error("expected the promise to reject");
}

/** A fixed, obviously fake 32-byte key. */
export const TEST_KEY = "0123456789abcdef".repeat(4);
export const TEST_KEY_2 = "fedcba9876543210".repeat(4);

/** A clock that only moves when told to. */
export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export const FAKE_NOW = Date.parse("2026-11-10T12:00:00.000Z");

export function fakeClock(start = FAKE_NOW): FakeClock {
  let now = start;
  return {
    now: () => now,
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

/** A fresh temp directory and a cleanup that removes it. */
export function tempDir(prefix = "hydra-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

export interface CapturedLogger extends Logger {
  lines: Record<string, unknown>[];
}

/** A logger that keeps parsed lines in memory. */
export function captureLogger(): CapturedLogger {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level: "debug",
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return Object.assign(log, { lines });
}

export interface RecordingAlerter extends Alerter {
  alerts: { key: string; message: string }[];
}

export function recordingAlerter(): RecordingAlerter {
  const alerts: { key: string; message: string }[] = [];
  return {
    alerts,
    alert: async (key, message) => {
      alerts.push({ key, message });
    },
  };
}

/** A valid selfhost config with a test key; override any env var. */
export function testConfig(env: Env = {}): Config {
  return loadConfig({ HYDRA_MODE: "selfhost", ENCRYPTION_KEY: TEST_KEY, ...env });
}

export interface TempDb {
  conn: Conn;
  path: string;
  dir: string;
  cleanup: () => void;
}

/** A fresh, migrated database in its own temp directory. */
export async function tempDb(options: { clock?: Clock; log?: Logger } = {}): Promise<TempDb> {
  const { dir, cleanup } = tempDir();
  const path = join(dir, "sqlite.db");
  const conn = await openDatabase(path, {
    log: options.log ?? createLogger({ sink: () => {} }),
    alerter: recordingAlerter(),
    clock: options.clock ?? fakeClock(),
  });
  return {
    conn,
    path,
    dir,
    cleanup: () => {
      conn.close();
      cleanup();
    },
  };
}

export interface FakeResponseSpec {
  status?: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
  init: OutboundInit;
}

type Responder =
  | FakeResponseSpec
  | Response
  | Error
  | ((call: FetchCall) => FakeResponseSpec | Response | Promise<FakeResponseSpec | Response>);

export interface FakeFetch extends OutboundFetch {
  calls: FetchCall[];
  /** Answers every matching request (method "*" matches any). Later routes win. */
  on(method: string, url: string | RegExp, responder: Responder): FakeFetch;
  /** Answers the next unmatched request once, in order. A Response is single-use. */
  enqueue(responder: Responder): FakeFetch;
}

function toResponse(spec: FakeResponseSpec | Response): Response {
  if (spec instanceof Response) return spec;
  const headers = new Headers(spec.headers);
  let body = spec.body ?? null;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Response(body, { status: spec.status ?? 200, headers });
}

/**
 * A scriptable OutboundFetch that records every call. Routes are checked
 * first, then the queue; anything else throws so tests never hit the network.
 */
export function fakeFetch(): FakeFetch {
  const routes: { method: string; url: string | RegExp; responder: Responder }[] = [];
  const queue: Responder[] = [];
  const calls: FetchCall[] = [];

  const fn = async (input: string | URL, init: OutboundInit): Promise<Response> => {
    const url = input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body == null ? null : "[body]";
    const call: FetchCall = { url, method, headers: new Headers(init.headers), body, init };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    const route = routes.findLast(
      (r) =>
        (r.method === "*" || r.method.toUpperCase() === method) &&
        (typeof r.url === "string" ? url === r.url || url.startsWith(r.url) : r.url.test(url)),
    );
    const responder = route?.responder ?? queue.shift();
    if (responder === undefined) throw new Error(`fakeFetch: unexpected ${method} ${url}`);
    if (responder instanceof Error) throw responder;
    const spec = typeof responder === "function" ? await responder(call) : responder;
    return toResponse(spec);
  };

  const fake: FakeFetch = Object.assign(fn, {
    calls,
    on(method: string, url: string | RegExp, responder: Responder) {
      routes.push({ method, url, responder });
      return fake;
    },
    enqueue(responder: Responder) {
      queue.push(responder);
      return fake;
    },
  });
  return fake;
}

export interface TestDeps extends Deps {
  clock: FakeClock;
  fetch: FakeFetch;
  alerter: RecordingAlerter;
  log: CapturedLogger;
  dbPath: string;
  cleanup: () => void;
}

export interface TestDepsOverrides {
  env?: Env;
  clock?: FakeClock;
  fetch?: FakeFetch;
}

/** Deps over a fresh temp database with fakes everywhere. Call cleanup() when done. */
export async function testDeps(overrides: TestDepsOverrides = {}): Promise<TestDeps> {
  const clock = overrides.clock ?? fakeClock();
  const log = captureLogger();
  const db = await tempDb({ clock, log });
  return {
    config: testConfig({ DATABASE_PATH: db.path, ...overrides.env }),
    db: db.conn.db,
    sqlite: db.conn.sqlite,
    log,
    alerter: recordingAlerter(),
    clock,
    fetch: overrides.fetch ?? fakeFetch(),
    metrics: createMetrics(),
    dbPath: db.path,
    cleanup: db.cleanup,
  };
}
