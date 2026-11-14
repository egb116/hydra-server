import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupDatabase, dailyBackupPath, rotate } from "../src/db/backup";
import { openConnection } from "../src/db/connection";
import {
  MIGRATIONS_FOLDER,
  MigrationError,
  pendingMigrations,
  runMigrations,
} from "../src/db/migrate";
import { captureLogger, fakeClock, tempDir } from "./helpers";

let dir: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});
afterEach(() => cleanup());

const opts = () => ({ log: captureLogger(), clock: fakeClock() });

/** A copy of the real migrations plus a fake later one, to simulate an upgrade. */
function migrationsWithExtra(tag: string, when: number, sql: string): string {
  const folder = join(dir, `migrations-${tag}`);
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  journal.entries.push({
    idx: journal.entries.length,
    version: "6",
    when,
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

/** A copy of the real migrations with only the first `n` journal entries. */
function migrationsUpTo(n: number): string {
  const folder = join(dir, `migrations-upto-${n}`);
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, n);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

/** One customer with a device, an account, a device link and a notified item. */
function seedGraph(sqlite: Database): void {
  sqlite.run(
    "INSERT INTO customers (id, customer_id, is_pro, created_at, updated_at) VALUES (1, 'c1', 1, 1, 1)",
  );
  sqlite.run(
    "INSERT INTO devices (id, push_token, customer_id, last_registered_at, created_at) VALUES (1, 'tok', 1, 1, 1)",
  );
  sqlite.run(
    `INSERT INTO reddit_accounts (id, customer_id, username, session_enc, next_check_at, baseline_at, created_at, updated_at)
     VALUES (1, 1, 'u1', 'enc', 1, 1, 1, 1)`,
  );
  sqlite.run("INSERT INTO device_accounts (device_id, account_id) VALUES (1, 1)");
  sqlite.run("INSERT INTO notified_items (account_id, item_id, notified_at) VALUES (1, 't1_x', 1)");
}

const count = (sqlite: Database, table: string): number =>
  sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;

describe("runMigrations", () => {
  test("a fresh database is migrated without a backup", () => {
    const path = join(dir, "sqlite.db");
    const conn = openConnection(path);
    try {
      // Every shipped migration, baseline first.
      const tags = pendingMigrations(conn.sqlite).map((m) => m.tag);
      expect(tags[0]).toBe("0000_baseline");
      expect(tags).toContain("0001_admin_indexes");
      const result = runMigrations(conn, path, opts());
      expect(result).toEqual({ applied: tags, backupPath: null });
      expect(pendingMigrations(conn.sqlite)).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".bak"))).toEqual([]);
      // Nothing pending: a no-op, still no backup.
      expect(runMigrations(conn, path, opts())).toEqual({ applied: [], backupPath: null });
    } finally {
      conn.close();
    }
  });

  test("pending migrations on a non-empty database write a pre-migration backup first", () => {
    const path = join(dir, "sqlite.db");
    const conn = openConnection(path);
    try {
      runMigrations(conn, path, opts());
      conn.sqlite.run(
        "INSERT INTO customers (customer_id, is_pro, created_at, updated_at) VALUES ('before', 1, 1, 1)",
      );
      const folder = migrationsWithExtra(
        "0001_extra",
        Date.now() + 1000,
        "CREATE TABLE extra (id integer PRIMARY KEY);",
      );
      const result = runMigrations(conn, path, { ...opts(), migrationsFolder: folder });
      expect(result.applied).toEqual(["0001_extra"]);
      expect(result.backupPath).toBe(`${path}.pre-0001_extra.bak`);
      expect(existsSync(result.backupPath!)).toBe(true);

      // The backup is the database as it was before the migration.
      const backup = openConnection(result.backupPath!);
      try {
        expect(backup.sqlite.query("SELECT customer_id FROM customers").all()).toEqual([
          { customer_id: "before" },
        ]);
        expect(
          backup.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'extra'").get(),
        ).toBeNull();
      } finally {
        backup.close();
      }
      expect(
        conn.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'extra'").get(),
      ).toEqual({ name: "extra" });
    } finally {
      conn.close();
    }
  });

  test("keeps only the newest 3 pre-migration backups", () => {
    const path = join(dir, "sqlite.db");
    const conn = openConnection(path);
    try {
      runMigrations(conn, path, opts());
      // Older backups from earlier upgrades.
      for (const [i, tag] of ["a", "b", "c"].entries()) {
        const file = `${path}.pre-${tag}.bak`;
        writeFileSync(file, "old");
        const t = new Date(Date.now() - (10 - i) * 60_000);
        utimesSync(file, t, t);
      }
      const folder = migrationsWithExtra(
        "0001_extra",
        Date.now() + 1000,
        "CREATE TABLE extra (id integer PRIMARY KEY);",
      );
      runMigrations(conn, path, { ...opts(), migrationsFolder: folder });
      const backups = readdirSync(dir)
        .filter((f) => f.includes(".pre-") && f.endsWith(".bak"))
        .sort();
      expect(backups).toEqual([
        "sqlite.db.pre-0001_extra.bak",
        "sqlite.db.pre-b.bak",
        "sqlite.db.pre-c.bak",
      ]);
    } finally {
      conn.close();
    }
  });

  test("a drizzle-kit table-recreate migration keeps the child rows (no cascade on DROP TABLE)", () => {
    const path = join(dir, "sqlite.db");
    const conn = openConnection(path);
    try {
      runMigrations(conn, path, opts());
      seedGraph(conn.sqlite);
      // The shape drizzle-kit generates for e.g. a new NOT NULL column or changed FK.
      const recreate = [
        "PRAGMA foreign_keys=OFF;",
        `CREATE TABLE \`__new_reddit_accounts\` (
          \`id\` integer PRIMARY KEY NOT NULL, \`customer_id\` integer NOT NULL, \`username\` text NOT NULL,
          \`session_enc\` text NOT NULL, \`token_enc\` text, \`token_expires_at\` integer,
          \`status\` text DEFAULT 'active' NOT NULL, \`next_check_at\` integer NOT NULL, \`lease_until\` integer,
          \`consecutive_failures\` integer DEFAULT 0 NOT NULL, \`session_failures\` integer DEFAULT 0 NOT NULL,
          \`last_success_at\` integer, \`last_error\` text, \`last_error_at\` integer, \`baseline_at\` integer NOT NULL,
          \`proxy_key\` text, \`user_agent\` text, \`created_at\` integer NOT NULL, \`updated_at\` integer NOT NULL,
          \`note\` text DEFAULT '' NOT NULL,
          FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\`(\`id\`) ON UPDATE no action ON DELETE cascade
        );`,
        "INSERT INTO `__new_reddit_accounts` SELECT *, '' FROM `reddit_accounts`;",
        "DROP TABLE `reddit_accounts`;",
        "ALTER TABLE `__new_reddit_accounts` RENAME TO `reddit_accounts`;",
        "PRAGMA foreign_keys=ON;",
        "CREATE INDEX `reddit_accounts_next_check_at_idx` ON `reddit_accounts` (`next_check_at`);",
        "CREATE UNIQUE INDEX `reddit_accounts_customer_username_unique` ON `reddit_accounts` (`customer_id`,`username`);",
      ].join("--> statement-breakpoint\n");
      const folder = migrationsWithExtra("0001_recreate", Date.now() + 1000, recreate);
      const result = runMigrations(conn, path, { ...opts(), migrationsFolder: folder });
      expect(result.applied).toEqual(["0001_recreate"]);
      expect(count(conn.sqlite, "reddit_accounts")).toBe(1);
      expect(count(conn.sqlite, "device_accounts")).toBe(1);
      expect(count(conn.sqlite, "notified_items")).toBe(1);
      expect(conn.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // Enforcement is back on afterwards.
      expect(conn.sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(pendingMigrations(conn.sqlite, folder)).toEqual([]);
    } finally {
      conn.close();
    }
  });

  // 0002 rebuilds reddit_accounts and ai_calls with AUTOINCREMENT (ids are
  // never reused, so nothing keyed by id can reach another account).
  test("0002_autoincrement_ids keeps every row and stops id reuse", () => {
    const path = join(dir, "sqlite.db");
    const conn = openConnection(path);
    try {
      runMigrations(conn, path, { ...opts(), migrationsFolder: migrationsUpTo(2) });
      seedGraph(conn.sqlite);
      const result = runMigrations(conn, path, opts());
      expect(result.applied).toEqual(["0002_autoincrement_ids"]);
      expect(result.backupPath).not.toBeNull();
      expect(count(conn.sqlite, "reddit_accounts")).toBe(1);
      expect(count(conn.sqlite, "notified_items")).toBe(1);
      expect(conn.sqlite.query("SELECT device_id, account_id FROM device_accounts").all()).toEqual([
        { device_id: 1, account_id: 1 },
      ]);
      expect(conn.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
      conn.sqlite.run("DELETE FROM reddit_accounts WHERE id = 1");
      const next = conn.sqlite
        .query<{ id: number }, []>(
          `INSERT INTO reddit_accounts (customer_id, username, session_enc, next_check_at, baseline_at, created_at, updated_at)
           VALUES (1, 'u2', 'enc', 1, 1, 1, 1) RETURNING id`,
        )
        .get();
      expect(next?.id).toBe(2);
      // ai_calls too, so /admin can add up new calls by id range.
      const aiCalls = conn.sqlite
        .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'ai_calls'")
        .get();
      expect(aiCalls?.sql).toContain("AUTOINCREMENT");
    } finally {
      conn.close();
    }
  });

  test("a migration that would leave foreign key violations is rolled back and throws", () => {
    const path = join(dir, "sqlite.db");
    const conn = openConnection(path);
    try {
      runMigrations(conn, path, opts());
      seedGraph(conn.sqlite);
      const folder = migrationsWithExtra(
        "0001_orphans",
        Date.now() + 1000,
        "CREATE TABLE extra (id integer PRIMARY KEY);--> statement-breakpoint\nDELETE FROM customers;",
      );
      expect(() => runMigrations(conn, path, { ...opts(), migrationsFolder: folder })).toThrow(
        MigrationError,
      );
      // Nothing was applied: data, schema and the journal are as before.
      expect(count(conn.sqlite, "customers")).toBe(1);
      expect(count(conn.sqlite, "devices")).toBe(1);
      expect(
        conn.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'extra'").get(),
      ).toBeNull();
      expect(pendingMigrations(conn.sqlite, folder).map((m) => m.tag)).toEqual(["0001_orphans"]);
      expect(conn.sqlite.inTransaction).toBe(false);
      expect(conn.sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      conn.close();
    }
  });
});

describe("backupDatabase", () => {
  test("writes a consistent copy and overwrites the previous one", () => {
    const path = join(dir, "sqlite.db");
    const conn = openConnection(path);
    try {
      runMigrations(conn, path, opts());
      const dest = dailyBackupPath(path);
      conn.sqlite.run(
        "INSERT INTO customers (customer_id, is_pro, created_at, updated_at) VALUES ('one', 0, 1, 1)",
      );
      backupDatabase(conn, dest);
      conn.sqlite.run(
        "INSERT INTO customers (customer_id, is_pro, created_at, updated_at) VALUES ('two', 0, 1, 1)",
      );
      backupDatabase(conn, dest);
      expect(existsSync(`${dest}.tmp`)).toBe(false);
      const copy = openConnection(dest);
      try {
        expect(copy.sqlite.query("SELECT count(*) AS n FROM customers").get()).toEqual({ n: 2 });
      } finally {
        copy.close();
      }
    } finally {
      conn.close();
    }
  });

  test("rotate keeps the newest N matching files", () => {
    for (const [i, name] of ["x.pre-1.bak", "x.pre-2.bak", "x.pre-3.bak", "other.bak"].entries()) {
      const file = join(dir, name);
      writeFileSync(file, "");
      const t = new Date(Date.now() - (10 - i) * 60_000);
      utimesSync(file, t, t);
    }
    const deleted = rotate(dir, "x.pre-", ".bak", 2);
    expect(deleted).toEqual([join(dir, "x.pre-1.bak")]);
    expect(readdirSync(dir).sort()).toEqual(["other.bak", "x.pre-2.bak", "x.pre-3.bak"]);
  });
});
