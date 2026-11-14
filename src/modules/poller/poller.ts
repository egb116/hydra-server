/**
 * The lease-based due-account poller and the checkAccount pipeline.
 *
 * Every tick (1 s) claims up to POLL_CONCURRENCY - inFlight due accounts with
 * one atomic UPDATE … RETURNING that sets a 2 min lease, and starts a check
 * for each. A check that finishes claims a replacement right away, so a fast
 * Reddit isn't capped at POLL_CONCURRENCY checks per tick. A check decrypts
 * the account's secrets, fetches the inbox through the RedditClient, records
 * the new replies in notified_items (the outbox: at-most-once delivery),
 * pushes them to every linked device, and schedules the next check.
 */
import type { Database } from "bun:sqlite";
import { redditSecretAad, type SecretBox } from "../../lib/crypto";
import { raceSignal, settleWithin } from "../../lib/async";
import { describeThrown } from "../../lib/errors";
import { DAY_MS } from "../../lib/time";
import type { Deps, ModuleHealth } from "../../types";
import {
  type InboxReply,
  type InboxResult,
  type PushMessage,
  type PushSendResult,
  type PushService,
  type RedditClient,
  type RedditCredentials,
  RedditError,
  type RedditErrorKind,
  type RedditToken,
} from "../contracts";
import {
  reauthDelay,
  type Random,
  SESSION_DEAD_THRESHOLD,
  sessionRetryDelay,
  successDelay,
  transientDelay,
} from "./schedule";

export const TICK_MS = 1_000;
export const LEASE_MS = 120_000;
export const CHECK_DEADLINE_MS = 60_000;
export const STOP_TIMEOUT_MS = 10_000;
/** health() fails when the loop hasn't ticked for this long while running. */
export const HEARTBEAT_MAX_AGE_MS = 30_000;

export const NOTIFIED_RETENTION_MS = 30 * DAY_MS;
/**
 * Replies older than this are never notified, whatever baseline_at says. It is
 * shorter than the notified_items retention, so an old unread reply whose
 * outbox row was pruned can't be pushed a second time.
 */
export const MAX_NOTIFY_AGE_MS = NOTIFIED_RETENTION_MS - DAY_MS;
/**
 * v1's NEW_INBOX_START (tasks/CheckForMessages.ts): notifications from before
 * the switch to the new inbox are never sent.
 */
export const NEW_INBOX_START = Date.parse("2026-11-02T03:41:22.000Z");
const LAST_ERROR_MAX_CHARS = 500;

/** Failure-rate alert: over the last FAILURE_WINDOW checks (session_dead excluded). */
const FAILURE_WINDOW = 100;
const FAILURE_MIN_SAMPLES = 20;
const FAILURE_ALERT_RATIO = 0.5;
/**
 * Dead-session alert: session_dead is excluded above (one user's expired login
 * is routine), but a large share of them at once means Reddit misbehaves, and
 * left alone every account would go needs_reauth for 11–12 h in silence.
 */
export const SESSION_DEAD_WINDOW = 100;
export const SESSION_DEAD_MIN_SAMPLES = 50;
export const SESSION_DEAD_ALERT_RATIO = 0.2;
/** Consecutive failed ticks (about one per second) before "poller:stalled" is alerted. */
export const TICK_FAILURES_BEFORE_ALERT = 30;
/** "poller:lag" is alerted when the queue lag stays above one POLL_INTERVAL_MS this long. */
export const LAG_ALERT_AFTER_MS = 5 * 60_000;

export type FailureKind = RedditErrorKind | "timeout" | "crypto" | "internal";

export type CheckOutcome =
  | { status: "success"; notified: number; push: PushSendResult }
  | { status: "failure"; kind: FailureKind; message: string; needsReauth: boolean }
  /**
   * The check failed, but registration replaced the session while it ran, so
   * the failure belongs to the old session: only last_error is recorded and
   * the lease is released. The counters, status and next_check_at are left
   * to the new session.
   */
  | { status: "superseded"; kind: FailureKind; message: string }
  /** The account was deleted (or never existed) while the check ran. */
  | { status: "gone" }
  /** stop() gave up waiting for this check; nothing more was written. */
  | { status: "abandoned" };

export interface PollerOptions {
  reddit: RedditClient;
  push: PushService;
  secretBox: SecretBox;
  /** For tests: replaces Math.random in the schedule jitter. */
  random?: Random;
  tickMs?: number;
  checkDeadlineMs?: number;
  stopTimeoutMs?: number;
}

export interface Poller {
  /** Starts the 1 s loop (the first tick runs right away). */
  start(): void;
  /**
   * Stops claiming, waits up to timeoutMs (default 10 s) for in-flight checks,
   * then clears lease_until for anything still in flight and abandons it.
   */
  stop(timeoutMs?: number): Promise<void>;
  /** One loop iteration: claims up to the free slots and starts their checks. Returns the claimed ids. */
  tick(): number[];
  /** The atomic claim alone (sets a lease on up to `limit` due accounts). */
  claim(limit: number): number[];
  /** Runs one check. The caller must hold the account's lease. Never throws. */
  checkAccount(id: number): Promise<CheckOutcome>;
  /** Resolves when every in-flight check has finished. */
  idle(): Promise<void>;
  /** Deletes notified_items older than 30 days. Returns the number deleted. */
  pruneNotifiedItems(): number;
  health(): ModuleHealth;
  readonly inFlight: number;
  readonly running: boolean;
}

interface AccountRow {
  id: number;
  customerRowId: number;
  username: string;
  sessionEnc: string;
  tokenEnc: string | null;
  tokenExpiresAt: number | null;
  consecutiveFailures: number;
  sessionFailures: number;
  baselineAt: number;
  proxyKey: string | null;
  userAgent: string | null;
}

interface CheckContext {
  controller: AbortController;
  abandoned: boolean;
}

class CheckAborted extends Error {
  constructor(readonly reason: "deadline" | "stopped") {
    super(reason === "deadline" ? "check deadline exceeded" : "poller stopped");
    this.name = "CheckAborted";
  }
}

/**
 * Due, linked to a device, entitled (or selfhost), over `reddit_accounts a`
 * joined to `customers c`. An account that fails it is never claimed.
 */
export const CLAIMABLE_FILTER = `
  a.next_check_at <= $now
  AND EXISTS (SELECT 1 FROM device_accounts da WHERE da.account_id = a.id)
  AND ($selfhost OR (c.is_pro = 1 AND (c.pro_expires_at IS NULL OR c.pro_expires_at > $now)))`;

/** The claim filter from the spec: claimable and not leased. */
export const DUE_FILTER = `${CLAIMABLE_FILTER}
  AND (a.lease_until IS NULL OR a.lease_until < $now)`;

function prepareStatements(sqlite: Database) {
  return {
    claim: sqlite.query<
      { id: number },
      { now: number; leaseUntil: number; selfhost: number; limit: number }
    >(
      `UPDATE reddit_accounts SET lease_until = $leaseUntil
       WHERE id IN (
         SELECT a.id FROM reddit_accounts a JOIN customers c ON c.id = a.customer_id
         WHERE ${DUE_FILTER}
         ORDER BY a.next_check_at LIMIT $limit)
       RETURNING id`,
    ),
    oldestDue: sqlite.query<{ m: number | null }, { now: number; selfhost: number }>(
      `SELECT MIN(a.next_check_at) AS m
       FROM reddit_accounts a JOIN customers c ON c.id = a.customer_id
       WHERE ${DUE_FILTER}`,
    ),
    load: sqlite.query<AccountRow, { id: number }>(
      `SELECT id, customer_id AS customerRowId, username, session_enc AS sessionEnc,
              token_enc AS tokenEnc, token_expires_at AS tokenExpiresAt,
              consecutive_failures AS consecutiveFailures, session_failures AS sessionFailures,
              baseline_at AS baselineAt, proxy_key AS proxyKey, user_agent AS userAgent
       FROM reddit_accounts WHERE id = $id`,
    ),
    swapSession: sqlite.query<unknown, { id: number; old: string; next: string; now: number }>(
      `UPDATE reddit_accounts SET session_enc = $next, updated_at = $now
       WHERE id = $id AND session_enc = $old`,
    ),
    saveCredentials: sqlite.query<
      unknown,
      {
        id: number;
        old: string;
        next: string;
        tokenEnc: string | null;
        tokenExpiresAt: number | null;
        now: number;
      }
    >(
      // A null token keeps the stored one.
      `UPDATE reddit_accounts
       SET session_enc = $next, token_enc = COALESCE($tokenEnc, token_enc),
           token_expires_at = COALESCE($tokenExpiresAt, token_expires_at), updated_at = $now
       WHERE id = $id AND session_enc = $old`,
    ),
    savePersona: sqlite.query<
      unknown,
      { id: number; proxyKey: string | null; userAgent: string; now: number }
    >(
      `UPDATE reddit_accounts SET proxy_key = $proxyKey, user_agent = $userAgent, updated_at = $now
       WHERE id = $id`,
    ),
    alreadyNotified: sqlite.query<{ itemId: string }, { id: number; ids: string }>(
      `SELECT item_id AS itemId FROM notified_items
       WHERE account_id = $id AND item_id IN (SELECT value FROM json_each($ids))`,
    ),
    insertNotified: sqlite.query<unknown, { id: number; itemId: string; now: number }>(
      `INSERT OR IGNORE INTO notified_items (account_id, item_id, notified_at)
       VALUES ($id, $itemId, $now)`,
    ),
    /**
     * The devices to push to: every device linked to the account.
     */
    deviceTokens: sqlite.query<{ pushToken: string }, { id: number }>(
      `SELECT d.push_token AS pushToken
       FROM device_accounts da JOIN devices d ON d.id = da.device_id
       WHERE da.account_id = $id
       ORDER BY d.id`,
    ),
    success: sqlite.query<unknown, { id: number; next: number; now: number }>(
      `UPDATE reddit_accounts
       SET next_check_at = $next, consecutive_failures = 0, session_failures = 0,
           status = 'active', last_success_at = $now, lease_until = NULL, updated_at = $now
       WHERE id = $id`,
    ),
    failure: sqlite.query<
      unknown,
      {
        id: number;
        next: number;
        now: number;
        consecutive: number;
        session: number;
        status: string | null;
        error: string;
      }
    >(
      `UPDATE reddit_accounts
       SET next_check_at = $next, consecutive_failures = $consecutive, session_failures = $session,
           status = COALESCE($status, status), last_error = $error, last_error_at = $now,
           lease_until = NULL, updated_at = $now
       WHERE id = $id`,
    ),
    supersededFailure: sqlite.query<unknown, { id: number; now: number; error: string }>(
      `UPDATE reddit_accounts
       SET last_error = $error, last_error_at = $now, lease_until = NULL, updated_at = $now
       WHERE id = $id`,
    ),
    releaseLeases: sqlite.query<unknown, { ids: string }>(
      `UPDATE reddit_accounts SET lease_until = NULL
       WHERE id IN (SELECT value FROM json_each($ids))`,
    ),
    pruneNotified: sqlite.query<unknown, { before: number }>(
      "DELETE FROM notified_items WHERE notified_at < $before",
    ),
  };
}

export function createPoller(deps: Deps, options: PollerOptions): Poller {
  const { sqlite, clock, metrics, config } = deps;
  const log = deps.log.child({ module: "poller" });
  const { reddit, push, secretBox } = options;
  const random = options.random ?? Math.random;
  const tickMs = options.tickMs ?? TICK_MS;
  const checkDeadlineMs = options.checkDeadlineMs ?? CHECK_DEADLINE_MS;
  const defaultStopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const selfhost = config.mode === "selfhost" ? 1 : 0;
  const st = prepareStatements(sqlite);

  /**
   * Checks in flight, keyed per launch (not by account id): if an id were ever
   * claimed again while an old check still runs, the old check's cleanup must
   * not remove the new entry.
   */
  const inflight = new Map<number, { id: number; ctx: CheckContext; promise: Promise<void> }>();
  let launches = 0;
  let running = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTickAt: number | null = null;
  let tickFailures = 0;
  let lagSince: number | null = null;
  const recent: (FailureKind | null)[] = [];
  const recentSessionDead: boolean[] = [];

  function claim(limit: number): number[] {
    if (limit <= 0) return [];
    const now = clock.now();
    return st.claim.all({ now, leaseUntil: now + LEASE_MS, selfhost, limit }).map((row) => row.id);
  }

  function tick(): number[] {
    if (stopping) return [];
    const now = clock.now();
    const oldest = st.oldestDue.get({ now, selfhost })?.m ?? null;
    const lagMs = oldest === null ? 0 : Math.max(0, now - oldest);
    metrics.set("poller.lag_ms", lagMs);
    checkLag(lagMs, now);
    const ids = claimAndLaunch();
    lastTickAt = now;
    return ids;
  }

  /** Claims up to the free slots and starts a check for each. */
  function claimAndLaunch(): number[] {
    const ids = claim(config.pollConcurrency - inflight.size);
    for (const id of ids) launch(id);
    metrics.set("poller.inflight", inflight.size);
    return ids;
  }

  /** Alerts when the queue lag stays above one poll interval for LAG_ALERT_AFTER_MS. */
  function checkLag(lagMs: number, now: number): void {
    if (lagMs <= config.pollIntervalMs) {
      lagSince = null;
      return;
    }
    lagSince ??= now;
    if (now - lagSince < LAG_ALERT_AFTER_MS) return;
    void deps.alerter.alert(
      "poller:lag",
      `Poller: due accounts have waited over ${Math.round(config.pollIntervalMs / 1000)} s ` +
        `(now ${Math.round(lagMs / 1000)} s) for ${Math.round((now - lagSince) / 60_000)} min. ` +
        `Checks can't keep up: raise POLL_CONCURRENCY or look at Reddit/proxy latency.`,
    );
  }

  function launch(id: number): void {
    const key = ++launches;
    const ctx: CheckContext = { controller: new AbortController(), abandoned: false };
    const promise = runCheck(id, ctx)
      .then(() => undefined)
      .finally(() => {
        inflight.delete(key);
        metrics.set("poller.inflight", inflight.size);
        refill();
      });
    inflight.set(key, { id, ctx, promise });
  }

  /** A finished check frees a slot: fill it now instead of at the next tick. */
  function refill(): void {
    if (!running || stopping) return;
    try {
      claimAndLaunch();
    } catch (err) {
      // The next tick retries (and counts the failure).
      log.warn("claiming after a finished check failed", { err });
    }
  }

  function scheduleTick(delayMs: number): void {
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      try {
        tick();
        tickFailures = 0;
      } catch (err) {
        tickFailures++;
        metrics.inc("poller.tick_errors");
        log.error("poller tick failed", { err, consecutive: tickFailures });
        if (tickFailures >= TICK_FAILURES_BEFORE_ALERT) {
          void deps.alerter.alert(
            "poller:stalled",
            `Poller: the last ${tickFailures} ticks failed, so no account is being checked ` +
              `and /healthz reports the poller down (503). Latest error: ${describeThrown(err)}`,
          );
        }
      }
      if (running) scheduleTick(tickMs);
    }, delayMs);
  }

  function start(): void {
    if (running) return;
    running = true;
    stopping = false;
    lastTickAt = clock.now();
    log.info("poller started", { concurrency: config.pollConcurrency, selfhost: selfhost === 1 });
    scheduleTick(0);
  }

  async function stop(timeoutMs = defaultStopTimeoutMs): Promise<void> {
    running = false;
    stopping = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (inflight.size > 0) {
      await settleWithin(
        Promise.allSettled([...inflight.values()].map((e) => e.promise)),
        timeoutMs,
      );
    }
    const left = [...inflight.entries()];
    if (left.length > 0) {
      for (const [, entry] of left) {
        entry.ctx.abandoned = true;
        entry.ctx.controller.abort();
      }
      const ids = left.map(([, entry]) => entry.id);
      try {
        st.releaseLeases.run({ ids: JSON.stringify(ids) });
      } catch (err) {
        log.error("releasing leases failed", { err, ids });
      }
      log.warn("poller stopped with checks in flight; leases released", { accounts: ids });
    }
    log.info("poller stopped");
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight.values()].map((e) => e.promise));
    }
  }

  function health(): ModuleHealth {
    if (!running) return { ok: true, detail: { running: false, inFlight: inflight.size } };
    const ageMs = lastTickAt === null ? Infinity : clock.now() - lastTickAt;
    return {
      ok: ageMs < HEARTBEAT_MAX_AGE_MS,
      detail: {
        running: true,
        lastTickAt,
        heartbeatAgeMs: ageMs,
        inFlight: inflight.size,
        consecutiveTickFailures: tickFailures,
      },
    };
  }

  function pruneNotifiedItems(): number {
    const deleted = st.pruneNotified.run({ before: clock.now() - NOTIFIED_RETENTION_MS }).changes;
    if (deleted > 0) log.info("pruned notified items", { deleted });
    return deleted;
  }

  /** Records an outcome for the failure-rate alerts. */
  function track(kind: FailureKind | null): void {
    trackSessionDead(kind === "session_dead");
    if (kind === "session_dead" || kind === "crypto") return;
    recent.push(kind);
    if (recent.length > FAILURE_WINDOW) recent.shift();
    if (kind === null || recent.length < FAILURE_MIN_SAMPLES) return;
    const failures = recent.filter((k) => k !== null);
    if (failures.length / recent.length < FAILURE_ALERT_RATIO) return;
    const byKind: Record<string, number> = {};
    for (const k of failures) byKind[k] = (byKind[k] ?? 0) + 1;
    const breakdown = Object.entries(byKind)
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    const hint = byKind["graphql_error"]
      ? " Many graphql_error usually means Reddit rotated the persisted query hash (reddit/inbox.ts)."
      : "";
    void deps.alerter.alert(
      "poller:failure-rate",
      `Poller: ${failures.length} of the last ${recent.length} inbox checks failed (${breakdown}).${hint}`,
    );
  }

  /** Alerts when session_dead is a large share of recent checks (see SESSION_DEAD_WINDOW). */
  function trackSessionDead(dead: boolean): void {
    recentSessionDead.push(dead);
    if (recentSessionDead.length > SESSION_DEAD_WINDOW) recentSessionDead.shift();
    if (!dead || recentSessionDead.length < SESSION_DEAD_MIN_SAMPLES) return;
    const deadCount = recentSessionDead.filter(Boolean).length;
    if (deadCount / recentSessionDead.length < SESSION_DEAD_ALERT_RATIO) return;
    void deps.alerter.alert(
      "poller:session-dead-rate",
      `Poller: ${deadCount} of the last ${recentSessionDead.length} inbox checks said the ` +
        `Reddit session is dead. That many expired logins at once usually means Reddit is ` +
        `failing, and those accounts go needs_reauth (11–12 h pause) after 2 strikes.`,
    );
  }

  type FailureWrite =
    | { kind: "gone" }
    | { kind: "superseded" }
    | { kind: "recorded"; consecutive: number; needsReauth: boolean };

  /**
   * Records a failed check. The counters are computed from the row as it is
   * now, in one transaction, and only while the account still holds the
   * session the check used (`sessionEnc`). If registration replaced the
   * session mid-check, the failure is "superseded". If the account was deleted
   * meanwhile, it is "gone" and nothing is written. `saveUnused` stores
   * credentials the failed fetch still obtained, in the same transaction.
   */
  function recordFailure(
    row: AccountRow,
    sessionEnc: string,
    kind: FailureKind,
    message: string,
    now: number,
    saveUnused?: () => void,
  ): CheckOutcome {
    const error = `${kind}: ${message}`.slice(0, LAST_ERROR_MAX_CHARS);
    const write = sqlite.transaction((): FailureWrite => {
      const cur = st.load.get({ id: row.id });
      if (!cur) return { kind: "gone" };
      if (cur.sessionEnc !== sessionEnc) {
        st.supersededFailure.run({ id: row.id, now, error });
        return { kind: "superseded" };
      }
      saveUnused?.();
      const consecutive = cur.consecutiveFailures + 1;
      let session = cur.sessionFailures;
      let status: string | null = null;
      let next: number;
      if (kind === "crypto") {
        // Undecryptable secrets only come back with a new registration.
        status = "needs_reauth";
        next = now + reauthDelay(random);
      } else if (kind === "session_dead") {
        session++;
        if (session >= SESSION_DEAD_THRESHOLD) {
          status = "needs_reauth";
          next = now + reauthDelay(random);
        } else {
          next = now + sessionRetryDelay(random);
        }
      } else {
        next = now + transientDelay(config.pollIntervalMs, consecutive, random);
      }
      st.failure.run({ id: row.id, next, now, consecutive, session, status, error });
      return { kind: "recorded", consecutive, needsReauth: status === "needs_reauth" };
    });
    const result = write();
    if (result.kind === "gone") {
      log.debug("check failed for an account that is gone", { accountId: row.id, kind });
      return { status: "gone" };
    }
    metrics.inc(`poller.failure.${kind}`);
    track(kind);
    if (result.kind === "superseded") {
      metrics.inc("poller.superseded");
      log.info("check failed on a session replaced mid-check; counters left alone", {
        accountId: row.id,
        kind,
        error: message,
      });
      return { status: "superseded", kind, message };
    }
    const { consecutive, needsReauth } = result;
    if (needsReauth) {
      metrics.inc("poller.needs_reauth");
      log.info("account needs reauth", { accountId: row.id, kind });
    }
    const fields = { accountId: row.id, kind, error: message, consecutiveFailures: consecutive };
    if (kind === "internal") log.error("check failed", fields);
    else log.warn("check failed", fields);
    return { status: "failure", kind, message, needsReauth };
  }

  async function runCheck(id: number, ctx: CheckContext): Promise<CheckOutcome> {
    try {
      return await check(id, ctx);
    } catch (err) {
      // check() handles its own failures; this only guards against bugs there.
      log.error("check crashed", { accountId: id, err });
      return {
        status: "failure",
        kind: "internal",
        message: describeThrown(err),
        needsReauth: false,
      };
    }
  }

  async function check(id: number, ctx: CheckContext): Promise<CheckOutcome> {
    metrics.inc("poller.checks");
    const row = st.load.get({ id });
    if (!row) return { status: "gone" };
    const aad = redditSecretAad(row.customerRowId, row.username);

    // 1. The session; a v1 blob, or one under a previous key, is re-encrypted right away.
    let sessionEnc = row.sessionEnc;
    let session: string;
    try {
      session = secretBox.decryptSecret(sessionEnc, aad);
    } catch (err) {
      void deps.alerter.alert(
        "poller:decrypt-failed",
        `Poller: a reddit session could not be decrypted (account ${row.id}): ${describeThrown(err)}`,
      );
      return recordFailure(row, sessionEnc, "crypto", describeThrown(err), clock.now());
    }
    if (secretBox.needsReencrypt(sessionEnc)) {
      const upgraded = secretBox.encryptSecret(session, aad);
      const swapped = st.swapSession.run({
        id,
        old: sessionEnc,
        next: upgraded,
        now: clock.now(),
      }).changes;
      if (swapped > 0) {
        sessionEnc = upgraded;
        metrics.inc("poller.session_reencrypted");
      }
    }

    // 2. The persisted token, if any. An unreadable one is just re-fetched.
    let token: RedditToken | null = null;
    if (row.tokenEnc !== null && row.tokenExpiresAt !== null) {
      try {
        token = {
          value: secretBox.decryptSecret(row.tokenEnc, aad),
          expiresAt: row.tokenExpiresAt,
        };
      } catch (err) {
        log.warn("persisted token could not be decrypted; fetching a new one", {
          accountId: id,
          err,
        });
      }
    }

    /**
     * Writes a renewed session and a new token (either may be null). Only
     * inside a transaction that has checked session_enc is still sessionEnc.
     */
    const saveCredentials = (renewedSession: string | null, newToken: RedditToken | null): void => {
      const renewed = renewedSession !== null && renewedSession !== session ? renewedSession : null;
      const tokenChanged =
        newToken !== null &&
        (token === null ||
          token.value !== newToken.value ||
          token.expiresAt !== newToken.expiresAt);
      if (renewed === null && !tokenChanged) return;
      st.saveCredentials.run({
        id,
        old: sessionEnc,
        next: renewed === null ? sessionEnc : secretBox.encryptSecret(renewed, aad),
        tokenEnc: tokenChanged ? secretBox.encryptSecret(newToken.value, aad) : null,
        tokenExpiresAt: tokenChanged ? newToken.expiresAt : null,
        now: clock.now(),
      });
    };

    // 3. The inbox, under the overall deadline.
    const deadline = AbortSignal.timeout(checkDeadlineMs);
    const signal = AbortSignal.any([deadline, ctx.controller.signal]);
    const abortReason = (): CheckAborted =>
      new CheckAborted(ctx.controller.signal.aborted ? "stopped" : "deadline");
    // After a session_dead, the retry prefers a different proxy.
    const creds: RedditCredentials = {
      accountId: id,
      username: row.username,
      session,
      token,
      persona: { proxyKey: row.proxyKey, userAgent: row.userAgent },
      ...(row.sessionFailures > 0 ? { avoidProxyKey: row.proxyKey } : {}),
    };
    let inbox: InboxResult;
    try {
      inbox = await raceSignal(reddit.fetchInbox(creds, signal), signal, abortReason);
    } catch (err) {
      if (ctx.abandoned) return { status: "abandoned" };
      let kind: FailureKind;
      if (deadline.aborted) kind = "timeout";
      else if (err instanceof RedditError) kind = err.kind;
      else kind = "internal";
      const unused = err instanceof RedditError ? err.unused : undefined;
      return recordFailure(
        row,
        sessionEnc,
        kind,
        err instanceof Error ? err.message : describeThrown(err),
        clock.now(),
        unused && (() => saveCredentials(unused.renewedSession, unused.token)),
      );
    }
    if (ctx.abandoned) return { status: "abandoned" };

    // 4–6. Persist the renewed credentials and persona, pick the new replies,
    // and record them in the outbox, all in one transaction.
    const now = clock.now();
    const threshold = Math.max(row.baselineAt, NEW_INBOX_START, now - MAX_NOTIFY_AGE_MS);
    const persist = sqlite.transaction((): { fresh: InboxReply[]; tokens: string[] } | null => {
      // Deleted mid-check: write nothing.
      const current = st.load.get({ id });
      if (!current) return null;
      if (current.sessionEnc === sessionEnc) {
        saveCredentials(inbox.renewedSession, inbox.token);
      }
      // Otherwise registration replaced the session mid-check: the token and
      // renewed cookie belong to the old one, so they are dropped.
      if (inbox.persona.proxyKey !== row.proxyKey || inbox.persona.userAgent !== row.userAgent) {
        st.savePersona.run({
          id,
          proxyKey: inbox.persona.proxyKey,
          userAgent: inbox.persona.userAgent,
          now,
        });
      }
      const candidates = inbox.replies.filter((r) => r.unread && r.sentAt > threshold);
      if (candidates.length === 0) return { fresh: [], tokens: [] };
      const seen = new Set(
        st.alreadyNotified
          .all({ id, ids: JSON.stringify(candidates.map((r) => r.itemId)) })
          .map((r) => r.itemId),
      );
      const fresh: InboxReply[] = [];
      for (const reply of candidates) {
        if (seen.has(reply.itemId)) continue;
        seen.add(reply.itemId);
        if (st.insertNotified.run({ id, itemId: reply.itemId, now }).changes > 0) {
          fresh.push(reply);
        }
      }
      // Read in the same transaction as the deletion check.
      const tokens = fresh.length > 0 ? st.deviceTokens.all({ id }).map((d) => d.pushToken) : [];
      return { fresh, tokens };
    });
    const persisted = persist();
    if (persisted === null) return { status: "gone" };
    const { fresh: toSend, tokens } = persisted;

    // 7. Push every new reply to every linked device.
    let pushResult: PushSendResult = { sent: 0, failed: 0 };
    if (toSend.length > 0) {
      const messages: PushMessage[] = [];
      for (const reply of toSend) {
        for (const to of tokens) {
          messages.push({
            to,
            title: reply.title,
            body: reply.body,
            badge: inbox.unreadCount,
            sound: "default",
            data: { type: "inbox", username: row.username, itemId: reply.itemId },
          });
        }
      }
      if (messages.length > 0) {
        try {
          // The signal also drops sends still queued behind a slow Expo once
          // the check gives up, so a stall doesn't deliver a stale backlog later.
          pushResult = await raceSignal(push.send(messages, { signal }), signal, abortReason);
        } catch (err) {
          // The outbox rows stay: delivery is at most once.
          pushResult = { sent: 0, failed: messages.length };
          log.warn("push did not finish", { accountId: id, err });
        }
      }
      metrics.inc("poller.pushes.sent", pushResult.sent);
      metrics.inc("poller.pushes.failed", pushResult.failed);
      metrics.inc("poller.notified", toSend.length);
    }
    if (ctx.abandoned) return { status: "abandoned" };

    // 8. Schedule the next check.
    const doneAt = clock.now();
    // Ids are never reused (AUTOINCREMENT): a row deleted meanwhile is just missed.
    st.success.run({
      id,
      next: doneAt + successDelay(config.pollIntervalMs, random),
      now: doneAt,
    });
    metrics.inc("poller.success");
    track(null);
    log.debug("check ok", {
      accountId: id,
      replies: inbox.replies.length,
      notified: toSend.length,
    });
    return { status: "success", notified: toSend.length, push: pushResult };
  }

  return {
    start,
    stop,
    tick,
    claim,
    checkAccount: (id) => runCheck(id, { controller: new AbortController(), abandoned: false }),
    idle,
    pruneNotifiedItems,
    health,
    get inFlight() {
      return inflight.size;
    },
    get running() {
      return running;
    },
  };
}
