/**
 * One-time transition from the v1 database. Delete this file, its tests and fixtures once
 * every deployment has transitioned.
 *
 * Crash safety, step by step:
 * - While a live v1 database exists it is the source of truth: it is always
 *   copied afresh, and an existing `_old` is moved aside, never trusted.
 * - The v1 WAL is checkpointed into the main file first, so the main file
 *   alone is complete even if a crash interrupts the deletes below.
 * - `${path}_old` is written as `${path}_old.tmp` (removed again on failure)
 *   and renamed into place, so `_old` existing means it is a complete copy.
 * - The v1 files are deleted only after `_old` exists, WAL and SHM first, so
 *   a stale WAL can never be replayed onto the new database.
 * - The import runs in one transaction that also sets the marker, and every
 *   insert ignores rows that already exist, so rerunning is always safe.
 */
import type { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Alerter } from "../lib/alert";
import { type Clock, systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";
import { fsyncDir, fsyncFile } from "./backup";

export const LEGACY_IMPORT_MARKER = "legacy_import_completed_at";
/** Spread of the first check after the import. */
export const IMPORT_CHECK_JITTER_MS = 120_000;
/**
 * v1 never notified about inbox items sent before it switched to the new
 * inbox (tasks/CheckForMessages.ts NEW_INBOX_START). The baseline keeps that.
 */
export const V1_NEW_INBOX_START = Date.parse("2026-11-02T03:41:22.000Z");

export function legacyOldPath(path: string): string {
  return `${path}_old`;
}

function tableExists(sqlite: Database, name: string, schema = "main"): boolean {
  const row = sqlite
    .query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(name);
  return (row?.n ?? 0) > 0;
}

/** A v1 database has a `tasks` table and no `meta` table. */
export function isLegacyV1(sqlite: Database): boolean {
  return tableExists(sqlite, "tasks") && !tableExists(sqlite, "meta");
}

export interface PrepareOptions<C> {
  log: Logger;
  /** Opens a fresh connection at a path (connection.ts openConnection). */
  reopen: (path: string) => C;
  clock?: Clock;
  /** Told when an existing `_old` had to be moved aside. */
  alerter?: Alerter;
  /** For tests: free bytes in a directory (null when unknown). Defaults to statfs. */
  freeBytes?: (dir: string) => number | null;
}

/** Headroom on top of the v1 size that must be free before copying it. */
export const FREE_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

function defaultFreeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function isLockedFileError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES";
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The exact rollback steps for an operator. v2's main file AND its -wal/-shm
 * must go before `_old` is renamed back: a stale v2 WAL left next to the
 * restored v1 file would be replayed over it on v1's first open.
 */
export function rollbackInstructions(path: string): string[] {
  const oldPath = legacyOldPath(path);
  const aside = `${dirname(path)}/v2-aside`;
  return [
    "To roll back to v1: stop v2 first, then run",
    `  mkdir -p ${aside} && mv ${path} ${path}-wal ${path}-shm ${aside}/ ; mv ${oldPath} ${path}`,
    "(a missing -wal/-shm is fine), then deploy v1. Never rename _old while v2's -wal/-shm are still next to it.",
    "Docker Compose self-host: set the compose build context to https://github.com/dmilin1/hydra-server.git#last-v1 and run `docker compose up -d --build`.",
  ];
}

/**
 * Steps 1 and 2: copy the live v1 database to `${path}_old`, close it, delete
 * it, and return a fresh connection at `path`.
 *
 * While a live v1 database exists it is the only authoritative copy, so it is
 * always copied afresh. An `_old` that is already there (an earlier
 * interrupted boot, an operator's `cp`, a rollback done with `cp`) is never
 * trusted and never deleted: it is renamed to `_old.replaced-<ms>` and an
 * alert says so. Nothing is deleted unless the new copy is complete.
 */
export function prepareLegacyTransition<C extends { sqlite: Database; close(): void }>(
  conn: C,
  path: string,
  options: PrepareOptions<C>,
): C {
  const { log } = options;
  const now = (options.clock ?? systemClock).now();
  const oldPath = legacyOldPath(path);
  const tmp = `${oldPath}.tmp`;
  rmSync(tmp, { force: true });

  // Fold the WAL into the main file, so the main file alone is complete from
  // here on (a crash while deleting the v1 files can't leave a partial one).
  // A busy result means another connection still reads it: v1 is running.
  conn.sqlite.run("PRAGMA busy_timeout = 1000");
  const checkpoint = conn.sqlite
    .query<{ busy: number; log: number; checkpointed: number }, []>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    )
    .get();
  if (checkpoint && checkpoint.busy !== 0) {
    throw new Error(
      `legacy transition: ${path} is in use by another process (is v1 still running?); nothing was changed`,
    );
  }

  const needed = fileSize(path) + fileSize(`${path}-wal`) + FREE_SPACE_MARGIN_BYTES;
  const free = (options.freeBytes ?? defaultFreeBytes)(dirname(path));
  if (free !== null && free < needed) {
    throw new Error(
      `legacy transition: not enough free disk space to copy the v1 database (need ~${needed} bytes, ${free} free); nothing was changed`,
    );
  }

  log.info("legacy transition: copying the v1 database", { oldPath });
  try {
    // One consistent file that includes the WAL's contents.
    conn.sqlite.run("VACUUM INTO ?", [tmp]);
    fsyncFile(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }

  if (existsSync(oldPath)) {
    const aside = `${oldPath}.replaced-${now}`;
    renameSync(oldPath, aside);
    log.warn("legacy transition: an existing _old was moved aside; the live v1 database is used", {
      oldPath,
      movedTo: aside,
    });
    void options.alerter?.alert(
      "legacy-old-replaced",
      `Hydra v2: ${oldPath} already existed while a live v1 database was present. It was not trusted; it was moved to ${aside} and a fresh copy of the live v1 database was taken. Delete ${aside} once you have checked it is not needed.`,
    );
  }
  renameSync(tmp, oldPath);
  fsyncDir(dirname(oldPath));
  try {
    writeFileSync(`${oldPath}.README.txt`, `${rollbackInstructions(path).join("\n")}\n`);
  } catch (err) {
    log.warn("legacy transition: could not write the rollback README", { err });
  }

  conn.close();
  // WAL and SHM first: a leftover v1 WAL must never meet a new main file.
  for (const suffix of ["-wal", "-shm", "-journal", ""]) {
    const file = `${path}${suffix}`;
    try {
      rmSync(file, { force: true });
    } catch (err) {
      // Windows refuses to delete a file another program has open, such as a
      // SQLite viewer. The checkpoint above can't see an idle one.
      if (isLockedFileError(err)) {
        throw new Error(
          `legacy transition: ${file} is open in another program (a SQLite viewer or editor extension, or v1 still running). Close it and start again. The v1 database at ${path} is still complete; the next start copies it to ${oldPath} again and moves this copy aside.`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  fsyncDir(dirname(path));
  log.info("legacy transition: v1 database removed; opening a fresh one", { path });
  return options.reopen(path);
}

/**
 * Parses a v1 text timestamp: `YYYY-MM-DD HH:MM:SS` (SQLite CURRENT_TIMESTAMP,
 * UTC) or ISO 8601. A missing zone means UTC. Returns null if unparseable.
 */
export function parseV1Timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  const zone = m[3] ?? "Z";
  const ms = Date.parse(
    `${m[1]}T${m[2]}${zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`,
  );
  return Number.isFinite(ms) ? ms : null;
}

export interface LegacyImportResult {
  customers: number;
  devices: number;
  accounts: number;
  deviceLinks: number;
  aiUsageRows: number;
  /** Accounts whose v1 customer row doesn't exist (v2 requires one). */
  skippedOrphanAccounts: number;
  /** Push tokens that more than one v1 customer had (see importLegacy). */
  sharedPushTokens: number;
  /** v1 tasks rows (never imported). */
  ignoredTasks: number;
}

interface V1Customer {
  id: number;
  customer_id: string;
  is_subscribed: number | null;
  push_token: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface V1Account {
  id: number;
  customer_id: string;
  username: string;
  session: string;
  last_message_id: string | null;
  last_checked_at: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface V1AiRequest {
  customer_id: string;
  month: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_spent: number;
}

export interface ImportOptions {
  now: number;
  random?: () => number;
}

/** Step 4: imports a v1 database (`source`) into a migrated v2 one, in one transaction. */
export function importLegacy(
  target: Database,
  source: Database,
  options: ImportOptions,
): LegacyImportResult {
  for (const table of ["customers", "reddit_accounts", "tasks"]) {
    if (!tableExists(source, table)) {
      throw new Error(
        `legacy import: the _old database has no "${table}" table; is it a v1 database?`,
      );
    }
  }
  const { now } = options;
  const random = options.random ?? Math.random;
  const result: LegacyImportResult = {
    customers: 0,
    devices: 0,
    accounts: 0,
    deviceLinks: 0,
    aiUsageRows: 0,
    skippedOrphanAccounts: 0,
    sharedPushTokens: 0,
    ignoredTasks: 0,
  };

  const v1Customers = source
    .query<V1Customer, []>(
      "SELECT id, customer_id, is_subscribed, push_token, createdAt, updatedAt FROM customers ORDER BY id",
    )
    .all();
  const v1Accounts = source
    .query<V1Account, []>(
      "SELECT id, customer_id, username, session, last_message_id, last_checked_at, createdAt, updatedAt FROM reddit_accounts ORDER BY id",
    )
    .all();
  const v1AiRequests = tableExists(source, "ai_requests")
    ? source
        .query<V1AiRequest, []>(
          "SELECT customer_id, month, request_count, input_tokens, output_tokens, total_spent FROM ai_requests ORDER BY id",
        )
        .all()
    : [];
  result.ignoredTasks =
    source.query<{ n: number }, []>("SELECT count(*) AS n FROM tasks").get()?.n ?? 0;

  // A push token identifies one device, so it becomes one devices row, owned
  // by one customer: the most recently updated one. That is only a hint (v1's
  // 12 h subscription check bumps updatedAt of every subscribed customer), so
  // the device is also linked to the accounts of EVERY v1 customer that had
  // the token, exactly what v1 pushed for. The app's next registration
  // narrows the links to what it sends.
  const sharers = new Map<string, V1Customer[]>();
  for (const c of v1Customers) {
    const token = c.push_token?.trim();
    if (!token) continue;
    const list = sharers.get(token);
    if (list) list.push(c);
    else sharers.set(token, [c]);
  }
  const ts = (x: V1Customer) => parseV1Timestamp(x.updatedAt) ?? 0;
  const deviceOwner = new Map<string, V1Customer>();
  for (const [token, list] of sharers) {
    if (list.length > 1) result.sharedPushTokens++;
    let owner: V1Customer | undefined;
    for (const c of list) {
      if (!owner || ts(c) > ts(owner) || (ts(c) === ts(owner) && c.id > owner.id)) owner = c;
    }
    if (owner) deviceOwner.set(token, owner);
  }

  const insertCustomer = target.prepare<unknown, [string, number, number, number]>(
    `INSERT INTO customers (customer_id, is_pro, pro_expires_at, entitlement_source, entitlement_checked_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'legacy_import', NULL, ?, ?)
     ON CONFLICT (customer_id) DO NOTHING`,
  );
  const customerRowId = target.prepare<{ id: number }, [string]>(
    "SELECT id FROM customers WHERE customer_id = ?",
  );
  const insertDevice = target.prepare<unknown, [string, number, number, number]>(
    `INSERT INTO devices (push_token, customer_id, last_registered_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (push_token) DO NOTHING`,
  );
  const deviceRowId = target.prepare<{ id: number }, [string]>(
    "SELECT id FROM devices WHERE push_token = ?",
  );
  const insertAccount = target.prepare<
    unknown,
    [number, string, string, number, number, number, number]
  >(
    `INSERT INTO reddit_accounts (customer_id, username, session_enc, status, next_check_at, baseline_at, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT (customer_id, username) DO NOTHING`,
  );
  const accountRowId = target.prepare<{ id: number }, [number, string]>(
    "SELECT id FROM reddit_accounts WHERE customer_id = ? AND username = ?",
  );
  const insertLink = target.prepare<unknown, [number, number]>(
    "INSERT INTO device_accounts (device_id, account_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );
  const insertUsage = target.prepare<unknown, [string, string, number, number, number, number]>(
    `INSERT INTO ai_usage_monthly (customer_id, month, request_count, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (customer_id, month) DO NOTHING`,
  );
  const setMarker = target.prepare<unknown, [string, string]>(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );

  const run = target.transaction(() => {
    // customer_id (string) → v2 customers.id
    const rowIds = new Map<string, number>();
    for (const c of v1Customers) {
      const createdAt = parseV1Timestamp(c.createdAt) ?? now;
      const updatedAt = parseV1Timestamp(c.updatedAt) ?? now;
      result.customers += insertCustomer.run(
        c.customer_id,
        c.is_subscribed ? 1 : 0,
        createdAt,
        updatedAt,
      ).changes;
      const row = customerRowId.get(c.customer_id);
      if (row) rowIds.set(c.customer_id, row.id);
    }

    // v2 customers.id → the ids of the devices whose v1 token that customer had
    const devicesOf = new Map<number, number[]>();
    for (const [token, owner] of deviceOwner) {
      const ownerId = rowIds.get(owner.customer_id);
      if (ownerId === undefined) continue;
      // v1's updatedAt also moved with every subscription sweep, so it says
      // nothing about when the app last ran. Every imported device starts its
      // DEVICE_EXPIRY_MS window at the import, or the first prune after the
      // cutover would drop most of them.
      const createdAt = parseV1Timestamp(owner.createdAt) ?? now;
      result.devices += insertDevice.run(token, ownerId, now, createdAt).changes;
      const device = deviceRowId.get(token);
      if (!device) continue;
      for (const c of sharers.get(token) ?? []) {
        const customerId = rowIds.get(c.customer_id);
        if (customerId === undefined) continue;
        const list = devicesOf.get(customerId);
        if (list) list.push(device.id);
        else devicesOf.set(customerId, [device.id]);
      }
    }

    for (const a of v1Accounts) {
      const customerId = rowIds.get(a.customer_id);
      if (customerId === undefined) {
        result.skippedOrphanAccounts++;
        continue;
      }
      const baselineAt = importBaseline(a.last_message_id, a.last_checked_at, now);
      const nextCheckAt = now + Math.floor(random() * IMPORT_CHECK_JITTER_MS);
      const createdAt = parseV1Timestamp(a.createdAt) ?? now;
      const updatedAt = parseV1Timestamp(a.updatedAt) ?? now;
      result.accounts += insertAccount.run(
        customerId,
        a.username,
        a.session, // still v1 ciphertext; re-encrypted lazily by the poller
        nextCheckAt,
        baselineAt,
        createdAt,
        updatedAt,
      ).changes;
      const account = accountRowId.get(customerId, a.username);
      if (!account) continue;
      for (const deviceId of devicesOf.get(customerId) ?? []) {
        result.deviceLinks += insertLink.run(deviceId, account.id).changes;
      }
    }

    for (const r of v1AiRequests) {
      result.aiUsageRows += insertUsage.run(
        r.customer_id,
        r.month,
        r.request_count,
        r.input_tokens,
        r.output_tokens,
        r.total_spent,
      ).changes;
    }

    setMarker.run(LEGACY_IMPORT_MARKER, String(now));
  });
  try {
    run.immediate();
  } finally {
    for (const stmt of [
      insertCustomer,
      customerRowId,
      insertDevice,
      deviceRowId,
      insertAccount,
      accountRowId,
      insertLink,
      insertUsage,
      setMarker,
    ]) {
      stmt.finalize();
    }
  }
  return result;
}

/**
 * baseline_at for an imported account: only replies sent after it are pushed.
 *
 * - A watermark (the sentAt of the newest reply v1 pushed): that, but never
 *   before v1's new-inbox cutoff.
 * - No watermark: v1 never pushed anything since the cutoff, so every unread
 *   reply it saw at its last successful check was older than that check.
 *   Replies after `last_checked_at` it never saw, and would have pushed at its
 *   next check, so they must be pushed now (the cutover gap). Clamped to
 *   [cutoff, now].
 * - No usable `last_checked_at` (never checked, or a future time, which is how
 *   v1 paused an account after a SessionError): now, so nothing old bursts out.
 */
export function importBaseline(
  lastMessageId: string | null,
  lastCheckedAt: string | null,
  now: number,
): number {
  const watermark = parseV1Watermark(lastMessageId);
  if (watermark !== null) return Math.max(watermark, V1_NEW_INBOX_START);
  const checkedAt = parseV1Timestamp(lastCheckedAt);
  if (checkedAt === null || checkedAt > now) return now;
  return Math.max(checkedAt, V1_NEW_INBOX_START);
}

/**
 * v1's `last_message_id` holds the sentAt (ISO 8601) of the newest
 * notification sent. Older rows hold a Reddit message id, which isn't a date.
 */
export function parseV1Watermark(value: string | null): number | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  return parseV1Timestamp(value);
}

export function hasImportMarker(sqlite: Database): boolean {
  if (!tableExists(sqlite, "meta")) return false;
  const row = sqlite
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(LEGACY_IMPORT_MARKER);
  return row !== null;
}

export interface ImportIfPendingOptions {
  log: Logger;
  alerter: Alerter;
  clock: Clock;
  openReadonly: (path: string) => Database;
  random?: () => number;
}

/**
 * Step 4 and 5: if `${path}_old` exists and the marker is absent, import it,
 * then log and alert with the counts and the rollback steps. Returns null
 * when there was nothing to do.
 */
export async function importLegacyIfPending(
  conn: { sqlite: Database },
  path: string,
  options: ImportIfPendingOptions,
): Promise<LegacyImportResult | null> {
  const oldPath = legacyOldPath(path);
  if (!existsSync(oldPath) || hasImportMarker(conn.sqlite)) return null;

  const started = options.clock.now();
  options.log.info("legacy import: starting", { oldPath });
  const source = options.openReadonly(oldPath);
  let result: LegacyImportResult;
  try {
    result = importLegacy(conn.sqlite, source, {
      now: started,
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  } finally {
    source.close(true);
  }
  const durationMs = options.clock.now() - started;
  const rollback = rollbackInstructions(path);
  options.log.info("legacy import: completed", { ...result, durationMs, oldPath, rollback });
  await options.alerter.alert(
    "legacy-import",
    [
      "Hydra v2: legacy database import completed.",
      `customers ${result.customers}, devices ${result.devices}, accounts ${result.accounts}, device links ${result.deviceLinks}, AI usage rows ${result.aiUsageRows}`,
      `skipped: ${result.skippedOrphanAccounts} orphan accounts; ${result.ignoredTasks} v1 tasks not imported`,
      `${result.sharedPushTokens} push tokens were shared by several v1 customers: each device was linked to all of their accounts until the app registers again.`,
      `Rollback copy kept at ${oldPath} (${durationMs} ms).`,
      ...rollback,
    ].join("\n"),
  );
  return result;
}
