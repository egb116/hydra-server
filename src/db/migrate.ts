import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/log";
import { backupDatabase, rotate } from "./backup";

export const MIGRATIONS_FOLDER = join(import.meta.dirname, "migrations");
const MIGRATIONS_TABLE = "__drizzle_migrations";
/** How many pre-migration backups to keep. */
export const KEEP_PRE_MIGRATION_BACKUPS = 3;

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), when: z.number(), tag: z.string() })),
});

function readJournal(folder: string): JournalEntry[] {
  const raw = readFileSync(join(folder, "meta", "_journal.json"), "utf8");
  const journal = journalSchema.parse(JSON.parse(raw));
  return [...journal.entries].sort((a, b) => a.when - b.when);
}

function tableExists(sqlite: Database, name: string): boolean {
  return (
    sqlite
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name)?.n === 1
  );
}

function lastAppliedMillis(sqlite: Database): number | null {
  if (!tableExists(sqlite, MIGRATIONS_TABLE)) return null;
  const last = sqlite
    .query<{ created_at: number | string | null }, []>(
      `SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`,
    )
    .get();
  if (!last || last.created_at === null) return null;
  return Number(last.created_at);
}

/** Migrations not yet applied, using drizzle's rule (journal `when` > last applied `created_at`). */
export function pendingMigrations(sqlite: Database, folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const entries = readJournal(folder);
  const lastMillis = lastAppliedMillis(sqlite);
  if (lastMillis === null) return entries;
  return entries.filter((e) => e.when > lastMillis);
}

/** True when the database has any table of its own (not SQLite's, not drizzle's journal). */
export function hasUserTables(sqlite: Database): boolean {
  const row = sqlite
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?",
    )
    .get(MIGRATIONS_TABLE);
  return (row?.n ?? 0) > 0;
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/**
 * Applies the pending migrations the way drizzle's SQLite migrator does (same
 * journal table, same hash, same "newer than the last applied" rule), with
 * two differences that make table-recreate migrations safe:
 *
 * - `foreign_keys` is OFF while they run. drizzle-kit's recreate migrations
 *   start with `PRAGMA foreign_keys=OFF`, but that pragma is a no-op inside a
 *   transaction; with enforcement on, their `DROP TABLE` would fire every
 *   ON DELETE CASCADE and silently empty the child tables.
 * - Before COMMIT, `PRAGMA foreign_key_check` must come back empty. Otherwise
 *   everything is rolled back and a MigrationError is thrown, so a migration
 *   can never leave dangling references behind.
 */
function applyMigrations(sqlite: Database, folder: string): void {
  const lastMillis = lastAppliedMillis(sqlite);
  const migrations = readMigrationFiles({ migrationsFolder: folder }).filter(
    (m) => lastMillis === null || m.folderMillis > lastMillis,
  );
  if (migrations.length === 0) return;

  // Must happen outside a transaction to take effect.
  sqlite.run("PRAGMA foreign_keys = OFF");
  try {
    // Same DDL as drizzle's migrator, so drizzle-kit and drizzle stay compatible.
    sqlite.run(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
    );
    sqlite.run("BEGIN IMMEDIATE");
    try {
      for (const migration of migrations) {
        for (const stmt of migration.sql) {
          if (stmt.trim() !== "") sqlite.run(stmt);
        }
        sqlite.run(`INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES (?, ?)`, [
          migration.hash,
          migration.folderMillis,
        ]);
      }
      const violations = sqlite
        .query<ForeignKeyViolation, []>("PRAGMA foreign_key_check")
        .all()
        .slice(0, 20);
      if (violations.length > 0) {
        throw new MigrationError(
          `migrations would leave foreign key violations; rolled back: ${JSON.stringify(violations)}`,
        );
      }
      sqlite.run("COMMIT");
    } catch (err) {
      if (sqlite.inTransaction) sqlite.run("ROLLBACK");
      throw err;
    }
  } finally {
    sqlite.run("PRAGMA foreign_keys = ON");
  }
}

export interface MigrateOptions {
  log: Logger;
  clock: Clock;
  migrationsFolder?: string;
  keepBackups?: number;
}

export interface MigrateResult {
  applied: string[];
  backupPath: string | null;
}

/**
 * Applies pending migrations. When any are pending on a non-empty database,
 * first writes `${path}.pre-<tag>.bak` (tag = the last pending migration) and
 * keeps only the newest few of those.
 */
export function runMigrations(
  conn: { sqlite: Database },
  path: string,
  options: MigrateOptions,
): MigrateResult {
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const pending = pendingMigrations(conn.sqlite, folder);
  if (pending.length === 0) return { applied: [], backupPath: null };

  let backupPath: string | null = null;
  const last = pending.at(-1);
  if (last && path !== ":memory:" && hasUserTables(conn.sqlite)) {
    backupPath = `${path}.pre-${last.tag}.bak`;
    const started = options.clock.now();
    backupDatabase(conn, backupPath);
    const deleted = rotate(
      dirname(path),
      `${basename(path)}.pre-`,
      ".bak",
      options.keepBackups ?? KEEP_PRE_MIGRATION_BACKUPS,
    );
    options.log.info("pre-migration backup written", {
      backupPath,
      durationMs: options.clock.now() - started,
      rotatedOut: deleted.length,
    });
  }

  applyMigrations(conn.sqlite, folder);
  const applied = pending.map((e) => e.tag);
  options.log.info("migrations applied", { applied });
  return { applied, backupPath };
}
