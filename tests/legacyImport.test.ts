import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openConnection, openDatabase, openReadonly } from "../src/db/connection";
import {
  IMPORT_CHECK_JITTER_MS,
  importBaseline,
  importLegacyIfPending,
  isLegacyV1,
  LEGACY_IMPORT_MARKER,
  legacyOldPath,
  parseV1Timestamp,
  prepareLegacyTransition,
  V1_NEW_INBOX_START,
} from "../src/db/legacyImport";
import { runMigrations } from "../src/db/migrate";
import { createKeyring, createSecretBox, redditSecretAad } from "../src/lib/crypto";
import {
  captureLogger,
  FAKE_NOW,
  fakeClock,
  legacyFixture,
  type LegacyFixture,
  recordingAlerter,
  rejection,
  TEST_KEY,
  tempDir,
} from "./helpers";

const HALF = () => 0.5;
const EXPECTED_NEXT_CHECK = FAKE_NOW + Math.floor(0.5 * IMPORT_CHECK_JITTER_MS);

let dir: string;
let cleanup: () => void;
let path: string;
let fixture: LegacyFixture;

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
  path = join(dir, "sqlite.db");
  fixture = legacyFixture(path, TEST_KEY);
});

afterEach(() => cleanup());

function boot(dbPath = path) {
  const alerter = recordingAlerter();
  const log = captureLogger();
  return {
    alerter,
    log,
    open: () => openDatabase(dbPath, { log, alerter, clock: fakeClock(), random: HALF }),
  };
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
}

function snapshotCounts(sqlite: Database) {
  return Object.fromEntries(
    ["customers", "devices", "reddit_accounts", "device_accounts", "ai_usage_monthly", "meta"].map(
      (t) => [t, count(sqlite, t)],
    ),
  );
}

const EXPECTED_COUNTS = {
  customers: 4,
  devices: 2,
  reddit_accounts: 5,
  device_accounts: 4,
  ai_usage_monthly: 2,
  meta: 1,
};

describe("parseV1Timestamp", () => {
  test("parses both v1 formats as UTC", () => {
    expect(parseV1Timestamp("2025-03-01 12:34:56")).toBe(Date.UTC(2025, 2, 1, 12, 34, 56));
    expect(parseV1Timestamp("2026-11-09T20:15:00.123Z")).toBe(
      Date.UTC(2026, 10, 9, 20, 15, 0, 123),
    );
    expect(parseV1Timestamp("2026-11-09T20:15:00")).toBe(Date.UTC(2026, 10, 9, 20, 15, 0));
    expect(parseV1Timestamp("2026-10-25T23:40:08.323+0000")).toBe(
      Date.UTC(2026, 9, 25, 23, 40, 8, 323),
    );
    expect(parseV1Timestamp("t4_abc123")).toBeNull();
    expect(parseV1Timestamp("")).toBeNull();
    expect(parseV1Timestamp(null)).toBeNull();
  });
});

const iso = (ms: number) => new Date(ms).toISOString();

describe("importBaseline", () => {
  const NOW = FAKE_NOW;

  test("a watermark wins, but never before v1's new-inbox cutoff", () => {
    expect(importBaseline("2026-11-05T12:00:00.000Z", iso(NOW - 60_000), NOW)).toBe(
      Date.parse("2026-11-05T12:00:00.000Z"),
    );
    expect(importBaseline("2026-10-01T00:00:00.000Z", null, NOW)).toBe(V1_NEW_INBOX_START);
  });

  // A reply that arrived between v1's last check and the cutover would have
  // been pushed by v1 at its next check; it used to be dropped (baseline = now).
  test("no watermark: v1's last successful check, so the cutover gap is pushed", () => {
    expect(importBaseline(null, iso(NOW - 4 * 60_000), NOW)).toBe(NOW - 4 * 60_000);
    expect(importBaseline("t4_abc123", "2026-11-09 19:00:00", NOW)).toBe(
      Date.parse("2026-11-09T19:00:00.000Z"),
    );
    expect(importBaseline(null, "2026-10-01T00:00:00.000Z", NOW)).toBe(V1_NEW_INBOX_START);
  });

  test("never checked, or paused by v1 (a future last_checked_at): now", () => {
    expect(importBaseline(null, null, NOW)).toBe(NOW);
    expect(importBaseline(null, "garbage", NOW)).toBe(NOW);
    expect(importBaseline(null, iso(NOW + 11 * 60 * 60_000), NOW)).toBe(NOW);
  });
});

describe("legacy import", () => {
  test("imports the full mapping", async () => {
    const { alerter, open } = boot();
    const conn = await open();
    try {
      const s = conn.sqlite;
      expect(existsSync(legacyOldPath(path))).toBe(true);
      expect(isLegacyV1(s)).toBe(false);
      expect(s.query("SELECT name FROM sqlite_master WHERE name = 'tasks'").get()).toBeNull();
      expect(snapshotCounts(s)).toEqual(EXPECTED_COUNTS);

      const marker = s
        .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
        .get(LEGACY_IMPORT_MARKER);
      expect(marker?.value).toBe(String(FAKE_NOW));

      // customers
      type C = {
        id: number;
        customer_id: string;
        is_pro: number;
        pro_expires_at: number | null;
        entitlement_source: string | null;
        entitlement_checked_at: number | null;
        created_at: number;
        updated_at: number;
      };
      const customers = new Map(
        s
          .query<C, []>("SELECT * FROM customers")
          .all()
          .map((c) => [c.customer_id, c]),
      );
      for (const c of customers.values()) {
        expect(c.pro_expires_at).toBeNull();
        expect(c.entitlement_source).toBe("legacy_import");
        expect(c.entitlement_checked_at).toBeNull();
      }
      expect(customers.get("cust_pro")).toMatchObject({
        is_pro: 1,
        created_at: Date.UTC(2025, 2, 1, 12, 34, 56),
        updated_at: Date.parse("2026-11-01T10:00:00.000Z"),
      });
      expect(customers.get("cust_free")).toMatchObject({
        is_pro: 0,
        created_at: Date.UTC(2025, 4, 5, 5, 5, 5),
        updated_at: Date.UTC(2025, 4, 6, 6, 6, 6),
      });
      expect(customers.get("cust_shared_old")?.is_pro).toBe(0); // v1 NULL
      // Unparseable timestamp falls back to now.
      expect(customers.get("cust_shared_new")).toMatchObject({ is_pro: 1, created_at: FAKE_NOW });

      // devices: one per push token; the most recently updated customer owns a shared one.
      const devices = s
        .query<{ push_token: string; customer_id: number; last_registered_at: number }, []>(
          "SELECT push_token, customer_id, last_registered_at FROM devices ORDER BY push_token",
        )
        .all();
      expect(devices).toEqual([
        {
          push_token: "ExponentPushToken[pro-device]",
          customer_id: customers.get("cust_pro")!.id,
          last_registered_at: FAKE_NOW,
        },
        {
          push_token: "ExponentPushToken[shared]",
          customer_id: customers.get("cust_shared_new")!.id,
          last_registered_at: FAKE_NOW,
        },
      ]);

      // accounts
      type A = {
        id: number;
        customer_id: number;
        username: string;
        session_enc: string;
        token_enc: string | null;
        status: string;
        next_check_at: number;
        baseline_at: number;
        lease_until: number | null;
        consecutive_failures: number;
        session_failures: number;
        created_at: number;
        updated_at: number;
      };
      const accounts = new Map(
        s
          .query<A, []>("SELECT * FROM reddit_accounts")
          .all()
          .map((a) => [a.username, a]),
      );
      expect([...accounts.keys()].sort()).toEqual(["alice", "bob", "carol", "dave", "erin"]);
      const box = createSecretBox(createKeyring(TEST_KEY));
      for (const fa of fixture.accounts.filter((a) => a.username !== "zed")) {
        const a = accounts.get(fa.username)!;
        expect(a.customer_id).toBe(customers.get(fa.customerId)!.id);
        // The v1 ciphertext is copied unchanged and still decrypts.
        expect(a.session_enc).toBe(fa.sessionEnc);
        expect(box.isLegacy(a.session_enc)).toBe(true);
        expect(box.decryptSecret(a.session_enc, redditSecretAad(a.customer_id, a.username))).toBe(
          fa.session,
        );
        expect(a.status).toBe("active");
        expect(a.token_enc).toBeNull();
        expect(a.lease_until).toBeNull();
        expect(a.consecutive_failures).toBe(0);
        expect(a.session_failures).toBe(0);
        expect(a.next_check_at).toBe(EXPECTED_NEXT_CHECK);
        expect(a.created_at).toBe(Date.UTC(2025, 5, 1, 8));
        expect(a.updated_at).toBe(Date.parse("2026-11-09T20:15:00.123Z"));
      }
      // Watermarks: ISO → that time; before v1's cutoff → the cutoff. Without
      // one (null, or an old message id): v1's last check, else now.
      expect(accounts.get("alice")!.baseline_at).toBe(Date.parse("2026-11-05T12:00:00.000Z"));
      expect(accounts.get("bob")!.baseline_at).toBe(FAKE_NOW);
      expect(accounts.get("carol")!.baseline_at).toBe(Date.parse("2026-11-09T19:00:00.000Z"));
      expect(accounts.get("dave")!.baseline_at).toBe(FAKE_NOW);
      expect(accounts.get("erin")!.baseline_at).toBe(V1_NEW_INBOX_START);

      // device links: every account of a customer with a device. A shared token
      // links the accounts of every v1 customer that had it, as v1 pushed for all.
      const links = s
        .query<{ username: string; push_token: string }, []>(
          `SELECT a.username, d.push_token FROM device_accounts da
           JOIN reddit_accounts a ON a.id = da.account_id
           JOIN devices d ON d.id = da.device_id ORDER BY a.username`,
        )
        .all();
      expect(links).toEqual([
        { username: "alice", push_token: "ExponentPushToken[pro-device]" },
        { username: "bob", push_token: "ExponentPushToken[pro-device]" },
        { username: "dave", push_token: "ExponentPushToken[shared]" },
        { username: "erin", push_token: "ExponentPushToken[shared]" },
      ]);

      // ai_requests → ai_usage_monthly
      const usage = s.query("SELECT * FROM ai_usage_monthly ORDER BY customer_id").all();
      expect(usage).toEqual([
        {
          customer_id: "cust_free",
          month: "2026-11",
          request_count: 1,
          input_tokens: 10,
          output_tokens: 20,
          cost_usd: 0.0001,
        },
        {
          customer_id: "cust_pro",
          month: "2026-10",
          request_count: 12,
          input_tokens: 3400,
          output_tokens: 560,
          cost_usd: 0.0123,
        },
      ]);

      // One summary alert with the counts.
      expect(alerter.alerts).toHaveLength(1);
      expect(alerter.alerts[0]!.key).toBe("legacy-import");
      expect(alerter.alerts[0]!.message).toContain("customers 4, devices 2, accounts 5");
      expect(alerter.alerts[0]!.message).toContain("1 orphan accounts");
      expect(alerter.alerts[0]!.message).toContain("3 v1 tasks not imported");
      expect(alerter.alerts[0]!.message).toContain("1 push tokens were shared");
      // The exact rollback steps, including moving v2's -wal/-shm out of the way.
      expect(alerter.alerts[0]!.message).toContain(`mv ${path} ${path}-wal ${path}-shm`);
      expect(alerter.alerts[0]!.message).toContain(`mv ${legacyOldPath(path)} ${path}`);
      expect(readFileSync(`${legacyOldPath(path)}.README.txt`, "utf8")).toContain(
        `mv ${legacyOldPath(path)} ${path}`,
      );

      // Foreign keys hold.
      expect(s.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      conn.close();
    }

    // The rollback copy is still a complete, untouched v1 database.
    const old = new Database(legacyOldPath(path), { readonly: true });
    try {
      expect(isLegacyV1(old)).toBe(true);
      expect(count(old, "customers")).toBe(fixture.customers.length);
      expect(count(old, "reddit_accounts")).toBe(fixture.accounts.length);
      expect(count(old, "tasks")).toBe(fixture.taskCount);
    } finally {
      old.close(true);
    }
  });

  test("jitter spreads next_check_at over 0–120 s", async () => {
    const values = [0, 0.999999, 0.25];
    let i = 0;
    const conn = await openDatabase(path, {
      log: captureLogger(),
      alerter: recordingAlerter(),
      clock: fakeClock(),
      random: () => values[i++ % values.length]!,
    });
    try {
      const next = conn.sqlite
        .query<{ next_check_at: number }, []>("SELECT next_check_at FROM reddit_accounts")
        .all()
        .map((r) => r.next_check_at - FAKE_NOW);
      for (const offset of next) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(IMPORT_CHECK_JITTER_MS);
      }
      expect(new Set(next).size).toBeGreaterThan(1);
    } finally {
      conn.close();
    }
  });

  test("rerun after a crash: _old exists and the new DB is missing", async () => {
    // Steps 1-2 ran, then the process died before step 3.
    const fresh = prepareLegacyTransition(openConnection(path), path, {
      log: captureLogger(),
      reopen: openConnection,
    });
    fresh.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(legacyOldPath(path))).toBe(true);

    const { open, log } = boot();
    const conn = await open();
    try {
      expect(snapshotCounts(conn.sqlite)).toEqual(EXPECTED_COUNTS);
      expect(log.lines.some((l) => l["msg"] === "legacy import: completed")).toBe(true);
    } finally {
      conn.close();
    }
  });

  test("rerun after a crash: _old exists and the new DB is migrated but has no marker", async () => {
    const fresh = prepareLegacyTransition(openConnection(path), path, {
      log: captureLogger(),
      reopen: openConnection,
    });
    runMigrations(fresh, path, { log: captureLogger(), clock: fakeClock() });
    fresh.close();

    const { open } = boot();
    const conn = await open();
    try {
      expect(snapshotCounts(conn.sqlite)).toEqual(EXPECTED_COUNTS);
    } finally {
      conn.close();
    }
  });

  test("rerun after a crash during VACUUM INTO: a partial _old.tmp is discarded", async () => {
    writeFileSync(`${legacyOldPath(path)}.tmp`, "partial garbage");
    const { open } = boot();
    const conn = await open();
    try {
      expect(snapshotCounts(conn.sqlite)).toEqual(EXPECTED_COUNTS);
      expect(existsSync(`${legacyOldPath(path)}.tmp`)).toBe(false);
    } finally {
      conn.close();
    }
  });

  test("a failure inside the import rolls back everything; the rerun succeeds", async () => {
    const fresh = prepareLegacyTransition(openConnection(path), path, {
      log: captureLogger(),
      reopen: openConnection,
    });
    runMigrations(fresh, path, { log: captureLogger(), clock: fakeClock() });
    // Simulate a crash late in the transaction (after customers, accounts and links).
    fresh.sqlite.run(
      "CREATE TEMP TRIGGER fail_usage BEFORE INSERT ON main.ai_usage_monthly BEGIN SELECT RAISE(ABORT, 'simulated crash'); END",
    );
    const deps = {
      log: captureLogger(),
      alerter: recordingAlerter(),
      clock: fakeClock(),
      openReadonly,
    };
    expect((await rejection(importLegacyIfPending(fresh, path, deps))).message).toContain(
      "simulated crash",
    );
    expect(count(fresh.sqlite, "customers")).toBe(0);
    expect(count(fresh.sqlite, "reddit_accounts")).toBe(0);
    expect(count(fresh.sqlite, "meta")).toBe(0);
    fresh.close();

    const { open } = boot();
    const conn = await open();
    try {
      expect(snapshotCounts(conn.sqlite)).toEqual(EXPECTED_COUNTS);
    } finally {
      conn.close();
    }
  });

  test("_old is a complete copy including WAL contents that were never checkpointed", async () => {
    // Write more rows with checkpoints off, then snapshot the files while the
    // writer is still open: the main file lacks them, only the WAL has them.
    const writer = new Database(path);
    writer.run("PRAGMA wal_autocheckpoint = 0");
    writer.run(
      "INSERT INTO customers (customer_id, is_subscribed, push_token) VALUES ('cust_in_wal', 1, 'ExponentPushToken[wal]')",
    );
    writer.run(
      "INSERT INTO reddit_accounts (customer_id, username, session) VALUES ('cust_in_wal', 'walter', 'deadbeef:00')",
    );
    const crashed = join(dir, "crashed");
    mkdirSync(crashed);
    const crashedPath = join(crashed, "sqlite.db");
    copyFileSync(path, crashedPath);
    copyFileSync(`${path}-wal`, `${crashedPath}-wal`);
    const mainOnly = join(dir, "main-only.db");
    copyFileSync(path, mainOnly);
    writer.close(true);

    expect(statSync(`${crashedPath}-wal`).size).toBeGreaterThan(0);
    const mainOnlyDb = new Database(mainOnly, { readonly: true });
    expect(count(mainOnlyDb, "customers")).toBe(fixture.customers.length); // not in the main file
    mainOnlyDb.close(true);

    const { open } = boot(crashedPath);
    const conn = await open();
    try {
      expect(count(conn.sqlite, "customers")).toBe(EXPECTED_COUNTS.customers + 1);
      expect(count(conn.sqlite, "reddit_accounts")).toBe(EXPECTED_COUNTS.reddit_accounts + 1);
    } finally {
      conn.close();
    }

    const oldPath = legacyOldPath(crashedPath);
    expect(existsSync(`${oldPath}-wal`)).toBe(false);
    // A single self-contained file in rollback-journal mode (header bytes 18-19 = 1).
    const header = readFileSync(oldPath).subarray(0, 20);
    expect([header[18], header[19]]).toEqual([1, 1]);
    const old = new Database(oldPath, { readonly: true });
    try {
      expect(
        old.query("SELECT customer_id FROM customers WHERE customer_id = 'cust_in_wal'").get(),
      ).toEqual({ customer_id: "cust_in_wal" });
      expect(count(old, "reddit_accounts")).toBe(fixture.accounts.length + 1);
    } finally {
      old.close(true);
    }
  });

  test("is idempotent", async () => {
    const first = boot();
    let conn = await first.open();
    const before = snapshotCounts(conn.sqlite);
    const marker = conn.sqlite.query("SELECT value FROM meta").get();
    conn.close();

    // A normal second boot does nothing.
    const second = boot();
    conn = await second.open();
    try {
      expect(snapshotCounts(conn.sqlite)).toEqual(before);
      expect(conn.sqlite.query("SELECT value FROM meta").get()).toEqual(marker);
      expect(second.alerter.alerts).toHaveLength(0);

      // Even without the marker, a rerun inserts no duplicates.
      conn.sqlite.run("DELETE FROM meta");
      const result = await importLegacyIfPending(conn, path, {
        log: captureLogger(),
        alerter: recordingAlerter(),
        clock: fakeClock(),
        openReadonly,
      });
      expect(result).toMatchObject({
        customers: 0,
        devices: 0,
        accounts: 0,
        deviceLinks: 0,
        aiUsageRows: 0,
      });
      expect(snapshotCounts(conn.sqlite)).toEqual(before);
    } finally {
      conn.close();
    }
  });

  test("does nothing when the database is already v2", async () => {
    const { dir: dir2, cleanup: cleanup2 } = tempDir();
    try {
      const v2Path = join(dir2, "sqlite.db");
      const { open, alerter, log } = boot(v2Path);
      let conn = await open();
      conn.sqlite.run(
        "INSERT INTO customers (customer_id, is_pro, created_at, updated_at) VALUES ('c', 1, 1, 1)",
      );
      conn.close();
      conn = await open();
      try {
        expect(count(conn.sqlite, "customers")).toBe(1);
        expect(count(conn.sqlite, "meta")).toBe(0);
        expect(existsSync(legacyOldPath(v2Path))).toBe(false);
        expect(alerter.alerts).toHaveLength(0);
        expect(log.lines.some((l) => String(l["msg"]).startsWith("legacy"))).toBe(false);
      } finally {
        conn.close();
      }
    } finally {
      cleanup2();
    }
  });
});

function addV1Customer(customerId: string): void {
  const v1 = new Database(path);
  try {
    v1.run("INSERT INTO customers (customer_id, is_subscribed) VALUES (?, 1)", [customerId]);
    v1.run("INSERT INTO reddit_accounts (customer_id, username, session) VALUES (?, ?, ?)", [
      customerId,
      `${customerId}_user`,
      "deadbeef:00",
    ]);
  } finally {
    v1.close(true);
  }
}

describe("legacy transition: an existing _old while a live v1 database exists", () => {
  test("a stale _old is moved aside, never trusted; the live v1 is imported", async () => {
    // An operator's earlier safety copy, then v1 kept writing.
    const v1 = new Database(path);
    v1.run("VACUUM INTO ?", [legacyOldPath(path)]);
    v1.close(true);
    addV1Customer("cust_after_copy");

    const { open, alerter } = boot();
    const conn = await open();
    try {
      expect(count(conn.sqlite, "customers")).toBe(EXPECTED_COUNTS.customers + 1);
      expect(
        conn.sqlite
          .query("SELECT 1 AS ok FROM customers WHERE customer_id = 'cust_after_copy'")
          .get(),
      ).toEqual({ ok: 1 });
      expect(alerter.alerts.map((a) => a.key)).toEqual(["legacy-old-replaced", "legacy-import"]);
    } finally {
      conn.close();
    }
    // Both copies are kept: the new _old has the new row, the stale one is aside.
    const aside = `${legacyOldPath(path)}.replaced-${FAKE_NOW}`;
    const stale = new Database(aside, { readonly: true });
    const fresh = new Database(legacyOldPath(path), { readonly: true });
    try {
      expect(count(stale, "customers")).toBe(fixture.customers.length);
      expect(count(fresh, "customers")).toBe(fixture.customers.length + 1);
    } finally {
      stale.close(true);
      fresh.close(true);
    }
  });

  // An idle SQLite viewer (a VS Code extension) holding the v1 file: the
  // checkpoint can't see it, and Windows refuses the delete with EBUSY. POSIX
  // deletes an open file, so this only arises on Windows.
  test.skipIf(process.platform !== "win32")(
    "a v1 file held open by another program fails clearly; the next start succeeds",
    async () => {
      const viewer = new Database(path, { readonly: true });
      viewer.query("SELECT count(*) FROM tasks").get();
      try {
        const err = await rejection(boot().open());
        expect(String(err)).toContain("is open in another program");
        // v1 is still there and complete.
        const v1 = new Database(path, { readonly: true });
        try {
          expect(isLegacyV1(v1)).toBe(true);
          expect(count(v1, "customers")).toBe(fixture.customers.length);
        } finally {
          v1.close(true);
        }
      } finally {
        viewer.close(true);
      }

      const { open, alerter } = boot();
      const conn = await open();
      try {
        expect(snapshotCounts(conn.sqlite)).toEqual(EXPECTED_COUNTS);
        expect(alerter.alerts.map((a) => a.key)).toEqual(["legacy-old-replaced", "legacy-import"]);
      } finally {
        conn.close();
      }
      expect(existsSync(`${legacyOldPath(path)}.replaced-${FAKE_NOW}`)).toBe(true);
    },
  );

  test("a garbage or empty _old is moved aside and the boot succeeds", async () => {
    writeFileSync(legacyOldPath(path), "not a database");
    const { open } = boot();
    const conn = await open();
    try {
      expect(snapshotCounts(conn.sqlite)).toEqual(EXPECTED_COUNTS);
    } finally {
      conn.close();
    }
    expect(readFileSync(`${legacyOldPath(path)}.replaced-${FAKE_NOW}`, "utf8")).toBe(
      "not a database",
    );
  });

  test("a failed copy (e.g. disk full) removes the partial tmp and leaves v1 untouched", () => {
    const conn = openConnection(path);
    const tmp = `${legacyOldPath(path)}.tmp`;
    const failing = new Proxy(conn.sqlite, {
      get(target, prop) {
        if (prop === "run") {
          return (sql: string, ...rest: unknown[]) => {
            if (sql.startsWith("VACUUM INTO")) {
              writeFileSync(tmp, "partial");
              throw new Error("SQLITE_FULL: database or disk is full");
            }
            return (target.run as (...a: unknown[]) => unknown).call(target, sql, ...rest);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const wrapped = { sqlite: failing, close: () => conn.close() };
    try {
      expect(() =>
        prepareLegacyTransition(wrapped, path, { log: captureLogger(), reopen: () => wrapped }),
      ).toThrow("SQLITE_FULL");
      expect(existsSync(tmp)).toBe(false);
      expect(existsSync(legacyOldPath(path))).toBe(false);
      expect(isLegacyV1(conn.sqlite)).toBe(true);
      expect(count(conn.sqlite, "customers")).toBe(fixture.customers.length);
    } finally {
      conn.close();
    }
  });

  test("refuses to start without enough free space; nothing is changed", () => {
    const conn = openConnection(path);
    try {
      expect(() =>
        prepareLegacyTransition(conn, path, {
          log: captureLogger(),
          reopen: openConnection,
          freeBytes: () => 1024,
        }),
      ).toThrow("not enough free disk space");
      expect(existsSync(legacyOldPath(path))).toBe(false);
      expect(existsSync(`${legacyOldPath(path)}.tmp`)).toBe(false);
      expect(isLegacyV1(conn.sqlite)).toBe(true);
    } finally {
      conn.close();
    }
  });

  test("refuses while another connection is reading the v1 database (v1 still running)", () => {
    const other = new Database(path);
    other.run("BEGIN");
    other.query("SELECT count(*) FROM customers").get();
    // Make the WAL non-empty so the checkpoint has work the reader blocks.
    const writer = new Database(path);
    writer.run("INSERT INTO customers (customer_id, is_subscribed) VALUES ('late', 0)");
    writer.close(true);
    const conn = openConnection(path);
    try {
      expect(() =>
        prepareLegacyTransition(conn, path, { log: captureLogger(), reopen: openConnection }),
      ).toThrow("in use by another process");
      expect(existsSync(legacyOldPath(path))).toBe(false);
      expect(existsSync(path)).toBe(true);
    } finally {
      conn.close();
      other.run("COMMIT");
      other.close(true);
    }
  });
});
