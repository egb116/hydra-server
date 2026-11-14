import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Alerter } from "../lib/alert";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/log";
import type { Db } from "../types";
import { importLegacyIfPending, isLegacyV1, prepareLegacyTransition } from "./legacyImport";
import { runMigrations } from "./migrate";
import * as schema from "./schema";

export interface Conn {
  db: Db;
  sqlite: Database;
  path: string;
  close(): void;
}

/**
 * How long a statement waits for another connection's write lock. All access
 * is synchronous on the event loop through this one connection, so there is
 * never contention inside the process; the only other writer is an operator's
 * sqlite3 session. A long wait would freeze the whole server (every poller
 * tick would block the loop for it), so a held lock fails fast instead.
 */
export const BUSY_TIMEOUT_MS = 250;

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`,
  "PRAGMA foreign_keys = ON",
  "PRAGMA temp_store = MEMORY",
];

/** Opens (creating if needed) a database file and sets the standard pragmas. No migrations. */
export function openConnection(path: string): Conn {
  if (path !== ":memory:") {
    const dir = dirname(path);
    // Bun on Windows throws EEXIST for mkdirSync(".", { recursive: true })
    // (a bare DATABASE_PATH like "sqlite.db"), so only create a missing dir.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(path, { create: true, readwrite: true, strict: true });
  try {
    for (const pragma of PRAGMAS) sqlite.run(pragma);
  } catch (err) {
    // Not a database (or a damaged one): release the file before failing.
    sqlite.close(true);
    throw err;
  }
  const db = drizzle({ client: sqlite, schema });
  let closed = false;
  return {
    db,
    sqlite,
    path,
    close() {
      if (closed) return;
      closed = true;
      // Finalizes outstanding statements (drizzle leaves prepared ones to the
      // GC) so the file handle is released now, not at some later GC.
      sqlite.close(true);
    },
  };
}

/** Opens a database file read-only (used for the v1 `_old` copy during the import). */
export function openReadonly(path: string): Database {
  return new Database(path, { readonly: true, strict: true });
}

export interface OpenDatabaseOptions {
  log: Logger;
  alerter: Alerter;
  clock: Clock;
  /** Defaults to src/db/migrations. */
  migrationsFolder?: string;
  /** For tests: replaces Math.random in the import's check jitter. */
  random?: () => number;
}

/**
 * The boot sequence for the database: the one-time v1 transition (if this is
 * a v1 database or an interrupted transition), then migrations (with a
 * pre-migration backup), then the legacy import (if pending).
 */
export async function openDatabase(path: string, options: OpenDatabaseOptions): Promise<Conn> {
  const { log } = options;
  let conn = openConnection(path);
  try {
    if (isLegacyV1(conn.sqlite)) {
      conn = prepareLegacyTransition(conn, path, {
        log,
        reopen: openConnection,
        clock: options.clock,
        alerter: options.alerter,
      });
    }
    runMigrations(conn, path, {
      log,
      clock: options.clock,
      ...(options.migrationsFolder === undefined
        ? {}
        : { migrationsFolder: options.migrationsFolder }),
    });
    await importLegacyIfPending(conn, path, {
      log,
      alerter: options.alerter,
      clock: options.clock,
      openReadonly,
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  } catch (err) {
    conn.close();
    throw err;
  }
  return conn;
}
