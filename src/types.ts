import type { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Hono } from "hono";
import type { Config } from "./config";
import type * as schema from "./db/schema";
import type { Alerter } from "./lib/alert";
import type { Clock } from "./lib/clock";
import type { OutboundFetch } from "./lib/http";
import type { JobRunner } from "./lib/jobs";
import type { Logger } from "./lib/log";
import type { Metrics } from "./lib/metrics";

/** The drizzle instance over the v2 schema. */
export type Db = BunSQLiteDatabase<typeof schema>;

/** Shared services every module gets. Built once in main.ts. */
export interface Deps {
  config: Config;
  /** drizzle instance */
  db: Db;
  /** raw bun:sqlite handle (transactions, pragmas) */
  sqlite: Database;
  log: Logger;
  alerter: Alerter;
  clock: Clock;
  /** src/lib/http.ts signature */
  fetch: OutboundFetch;
  metrics: Metrics;
}

/** Per-request context variables and the Bun bindings main.ts passes to app.fetch. */
export interface AppEnv {
  Bindings: {
    /** The TCP peer address, from Bun's server.requestIP. */
    remoteAddr?: string;
  };
  Variables: {
    requestId: string;
    log: Logger;
    /** Resolved once per request by requestContext (src/http/clientIp.ts). */
    clientIp: string;
  };
}

export type App = Hono<AppEnv>;

export interface ModuleHealth {
  ok: boolean;
  detail?: unknown;
}

export interface Module {
  name: string;
  /** Mount routes on the shared app. */
  routes?: (app: App) => void;
  /** Register periodic jobs. */
  jobs?: (runner: JobRunner) => void;
  /** Long-running workers (e.g. the poller). */
  start?: () => Promise<void> | void;
  /** Graceful shutdown (drain). */
  stop?: () => Promise<void>;
  /** Contributes to /healthz. */
  health?: () => ModuleHealth;
}
