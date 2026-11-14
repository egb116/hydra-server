import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { customers, type CustomerRow } from "../../db/schema";
import { FailureRateAlert } from "../../lib/alert";
import { BadRequest, Forbidden, describeThrown } from "../../lib/errors";
import { createLimiter } from "../../lib/limiter";
import { HOUR_MS, MINUTE_MS } from "../../lib/time";
import type { Deps } from "../../types";
import type { EntitlementService } from "../contracts";
import { isValidCustomerId } from "../../http/validation";
import { createRevenueCatClient, RevenueCatError, type RevenueCatClient } from "./revenuecat";

export const DEFAULT_MAX_AGE_MS = 10 * MINUTE_MS;
/** Reconcile rechecks a Pro customer whose last check is older than this. */
export const RECONCILE_RECHECK_AFTER_MS = 24 * HOUR_MS;
export const RECONCILE_CONCURRENCY = 2;
/** Reconcile alerts when at least this share of a batch failed. */
export const RECONCILE_ALERT_FAILURE_RATE = 0.25;
/** How long to stop calling RevenueCat after a 429 that gave no Retry-After or backoff_ms. */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60 * 1000;
/** Bounds on a 429's wait hint, so a bogus header neither hammers nor stalls us for long. */
export const MIN_RATE_LIMIT_BACKOFF_MS = 1000;
export const MAX_RATE_LIMIT_BACKOFF_MS = HOUR_MS;
/** Most ids one webhook event may name (app_user_id, original_app_user_id, aliases, transfers). */
export const MAX_WEBHOOK_IDS = 100;
/**
 * requirePro denying a Pro row whose pro_expires_at has passed starts a
 * background refresh at most this often per customer: a renewal RevenueCat
 * already knows about then unlocks within seconds, not at the next reconcile.
 */
export const EXPIRED_RECHECK_MAX_AGE_MS = 60 * 1000;
/**
 * Failure kinds alerted on the first failure: they mean misconfiguration (a
 * bad API key: 401/403) or that our quota is exhausted (429, which also starts
 * the service-wide backoff). Transient kinds (timeout, network, 5xx, parse)
 * are alerted on a failure rate instead.
 */
const IMMEDIATE_ALERT_KINDS: ReadonlySet<string> = new Set(["http", "rate_limited"]);

export const ENTITLEMENT_SOURCE_REVENUECAT = "revenuecat";

export type RefreshOutcome =
  | { ok: true; isPro: boolean; expiresAt: number | null }
  | { ok: false; kind: string };

/** RefreshOutcome.kind when no call was made because RevenueCat asked us to back off. */
export const BACKOFF_KIND = "backoff";

export interface ReconcileResult {
  /** Customers RevenueCat was asked about (due minus skipped). */
  checked: number;
  failed: number;
  /**
   * Due customers not asked this run because the service is stopping or
   * RevenueCat rate-limited us. They stay due (entitlement_checked_at is
   * unchanged), so the next run picks them up.
   */
  skipped: number;
}

export interface ReconcileOptions {
  /** Aborting stops the run from asking about any further customer. */
  signal?: AbortSignal;
}

export type EntitlementDeps = Pick<
  Deps,
  "config" | "db" | "log" | "alerter" | "clock" | "fetch" | "metrics"
>;

/** EntitlementService plus what the entitlements module itself needs. */
export interface EntitlementServiceImpl extends EntitlementService {
  readonly deps: EntitlementDeps;
  /**
   * Calls RevenueCat now (single-flight per customer: a refresh that started at
   * or after `notBefore` is joined instead of starting another) and stores the
   * result. Never rejects. In selfhost mode it does nothing.
   */
  refreshNow(customerId: string, notBefore?: number): Promise<RefreshOutcome>;
  /**
   * Refreshes, in the background with maxAge 0, every id that belongs to a known
   * customer. Unknown and invalid ids are ignored. Returns the known ids.
   */
  refreshKnownInBackground(customerIds: readonly string[]): string[];
  /**
   * Rechecks stale or expired Pro customers. Never throws for a single
   * customer. Stops starting new customers once `signal` aborts, stop() is
   * called, or RevenueCat answers 429; the rest are skipped and stay due.
   */
  reconcile(options?: ReconcileOptions): Promise<ReconcileResult>;
  /** Resolves once every refresh started so far (background ones included) has settled. */
  settled(): Promise<void>;
  /**
   * Shutdown: any running reconcile stops starting new customers, then this
   * waits for the refreshes already in flight (each bounded by the RevenueCat
   * timeout). Request-path refreshes keep working while HTTP drains.
   */
  stop(): Promise<void>;
}

export interface EntitlementServiceOptions {
  /** Replaces the RevenueCat client built from config (tests). */
  revenueCat?: RevenueCatClient;
}

export function createEntitlementService(
  deps: EntitlementDeps,
  options: EntitlementServiceOptions = {},
): EntitlementServiceImpl {
  const { config, db, log, alerter, clock, metrics } = deps;
  const selfhost = config.mode === "selfhost";
  const { projectId, apiKey } = config.revenuecat;
  const client: RevenueCatClient | null =
    options.revenueCat ??
    (!selfhost && projectId && apiKey
      ? createRevenueCatClient({ fetch: deps.fetch, projectId, apiKey })
      : null);

  /** In-flight RevenueCat calls by customer id. */
  const flights = new Map<string, { startedAt: number; promise: Promise<RefreshOutcome> }>();
  /** Every refresh promise not yet settled, for settled(). */
  const pending = new Set<Promise<unknown>>();
  /** Aborted by stop(). */
  const stopping = new AbortController();
  /** After a 429, no new RevenueCat call starts before this time. */
  let rateLimitedUntil = -Infinity;
  const failureRate = new FailureRateAlert({ alerter, clock });

  function backOff(err: RevenueCatError): number {
    const hinted = err.retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    const waitMs = Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, hinted));
    rateLimitedUntil = Math.max(rateLimitedUntil, clock.now() + waitMs);
    return waitMs;
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }

  function getCustomer(customerId: string): CustomerRow | undefined {
    return db.select().from(customers).where(eq(customers.customerId, customerId)).get();
  }

  function ensureCustomer(customerId: string): CustomerRow {
    if (!isValidCustomerId(customerId)) throw new BadRequest("Invalid customerId");
    const now = clock.now();
    db.insert(customers)
      .values({ customerId, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: customers.customerId })
      .run();
    const row = getCustomer(customerId);
    if (!row) throw new Error(`customer ${customerId} missing right after upsert`);
    return row;
  }

  function isEntitled(customer: CustomerRow, now: number): boolean {
    if (selfhost) return true;
    return customer.isPro && (customer.proExpiresAt == null || customer.proExpiresAt > now);
  }

  async function doRefresh(customerId: string): Promise<RefreshOutcome> {
    if (!client) return { ok: false, kind: "not_configured" };
    if (clock.now() < rateLimitedUntil) {
      // RevenueCat asked us to wait: keep the last known state without asking.
      metrics.inc("entitlements.refresh.backoff");
      log.debug("entitlement refresh skipped: RevenueCat rate limit backoff", {
        customerId,
        retryInMs: rateLimitedUntil - clock.now(),
      });
      return { ok: false, kind: BACKOFF_KIND };
    }
    try {
      const result = await client.getProEntitlement(customerId);
      const isPro = result.found && result.isPro;
      const expiresAt = result.found && result.isPro ? result.expiresAt : null;
      const now = clock.now();
      const before = getCustomer(customerId);
      const values = {
        isPro,
        proExpiresAt: expiresAt,
        entitlementSource: ENTITLEMENT_SOURCE_REVENUECAT,
        entitlementCheckedAt: now,
        updatedAt: now,
      };
      db.insert(customers)
        .values({ customerId, createdAt: now, ...values })
        .onConflictDoUpdate({ target: customers.customerId, set: values })
        .run();
      metrics.inc("entitlements.refresh.ok");
      failureRate.succeeded("revenuecat:failures");
      if (before && (before.isPro !== isPro || before.proExpiresAt !== expiresAt)) {
        log.info("entitlement changed", {
          customerId,
          isPro,
          proExpiresAt: expiresAt,
          wasPro: before.isPro,
          found: result.found,
        });
      }
      return { ok: true, isPro, expiresAt };
    } catch (err) {
      const kind = err instanceof RevenueCatError ? err.kind : "internal";
      const backoffMs =
        err instanceof RevenueCatError && err.kind === "rate_limited" ? backOff(err) : undefined;
      metrics.inc("entitlements.refresh.failed");
      metrics.inc(`entitlements.refresh.failed.${kind}`);
      log.warn("entitlement refresh failed; keeping the last known state", {
        customerId,
        kind,
        status: err instanceof RevenueCatError ? err.status : undefined,
        backoffMs,
        err,
      });
      const message = `RevenueCat entitlement check failed (${kind}): ${describeThrown(err)}. Keeping the last known state.`;
      if (IMMEDIATE_ALERT_KINDS.has(kind)) void alerter.alert(`revenuecat:${kind}`, message);
      else failureRate.failed("revenuecat:failures", message);
      return { ok: false, kind };
    }
  }

  function start(customerId: string): Promise<RefreshOutcome> {
    const startedAt = clock.now();
    const promise: Promise<RefreshOutcome> = doRefresh(customerId).finally(() => {
      if (flights.get(customerId)?.promise === promise) flights.delete(customerId);
    });
    flights.set(customerId, { startedAt, promise });
    return promise;
  }

  function refreshNow(customerId: string, notBefore = -Infinity): Promise<RefreshOutcome> {
    if (selfhost) return Promise.resolve({ ok: false, kind: "selfhost" });
    const flight = flights.get(customerId);
    if (!flight) return track(start(customerId));
    if (flight.startedAt >= notBefore) return flight.promise;
    // The in-flight call may predate what the caller needs to see (a webhook
    // that arrived mid-call): run one more call after it.
    return track(
      flight.promise.then(() => {
        const current = flights.get(customerId);
        return current && current.startedAt >= notBefore ? current.promise : start(customerId);
      }),
    );
  }

  async function refreshIfStale(customerId: string, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<void> {
    if (selfhost) return;
    if (!isValidCustomerId(customerId)) {
      log.warn("entitlement refresh skipped: invalid customerId");
      return;
    }
    const now = clock.now();
    try {
      const row = getCustomer(customerId);
      const checkedAt = row?.entitlementCheckedAt;
      if (checkedAt != null && now - checkedAt < maxAgeMs) return;
    } catch (err) {
      log.error("entitlement staleness check failed", { customerId, err });
      return;
    }
    await refreshNow(customerId, now - maxAgeMs);
  }

  function requirePro(customerId: string): CustomerRow {
    if (selfhost) return getCustomer(customerId) ?? ensureCustomer(customerId);
    const now = clock.now();
    const row = getCustomer(customerId);
    if (!row || !isEntitled(row, now)) {
      if (row?.isPro && row.proExpiresAt != null && row.proExpiresAt <= now) {
        // Most likely a renewal RevenueCat already has: look in the background
        // (this request still gets the 403), so the next one goes through.
        void track(
          refreshIfStale(customerId, EXPIRED_RECHECK_MAX_AGE_MS).catch((err: unknown) => {
            log.error("background entitlement refresh failed", { customerId, err });
          }),
        );
      }
      throw new Forbidden("Customer is not subscribed", { code: "not_subscribed" });
    }
    return row;
  }

  function refreshKnownInBackground(customerIds: readonly string[]): string[] {
    const unique = [...new Set(customerIds)].filter(isValidCustomerId).slice(0, MAX_WEBHOOK_IDS);
    const known = unique.filter((id) => getCustomer(id) !== undefined);
    for (const id of known) {
      void track(
        refreshIfStale(id, 0).catch((err: unknown) => {
          log.error("background entitlement refresh failed", { customerId: id, err });
        }),
      );
    }
    return known;
  }

  async function reconcile(run: ReconcileOptions = {}): Promise<ReconcileResult> {
    if (selfhost || !client) return { checked: 0, failed: 0, skipped: 0 };
    const signal = run.signal ? AbortSignal.any([stopping.signal, run.signal]) : stopping.signal;
    const now = clock.now();
    const due = db
      .select({ customerId: customers.customerId })
      .from(customers)
      .where(
        and(
          eq(customers.isPro, true),
          or(
            isNull(customers.entitlementCheckedAt),
            lt(customers.entitlementCheckedAt, now - RECONCILE_RECHECK_AFTER_MS),
            and(isNotNull(customers.proExpiresAt), lt(customers.proExpiresAt, now)),
          ),
        ),
      )
      .all();
    const limit = createLimiter(RECONCILE_CONCURRENCY);
    type Step = RefreshOutcome | { skipped: true };
    const steps = await Promise.all(
      due.map(({ customerId }) =>
        limit(async (): Promise<Step> => {
          // Checked as each customer's turn comes, so a stop or a 429 halts
          // the rest of the queue; they stay due for the next run.
          if (signal.aborted || clock.now() < rateLimitedUntil) return { skipped: true };
          try {
            const outcome = await refreshNow(customerId, now);
            return !outcome.ok && outcome.kind === BACKOFF_KIND ? { skipped: true } : outcome;
          } catch (err) {
            log.error("reconcile: customer failed", { customerId, err });
            return { ok: false, kind: "internal" };
          }
        }),
      ),
    );
    const skipped = steps.filter((o) => "skipped" in o).length;
    const failed = steps.filter((o) => "ok" in o && !o.ok).length;
    const checked = due.length - skipped;
    const result = { checked, failed, skipped };
    metrics.inc("entitlements.reconcile.checked", checked);
    metrics.inc("entitlements.reconcile.failed", failed);
    metrics.inc("entitlements.reconcile.skipped", skipped);
    if (skipped > 0) {
      log.warn("entitlements reconcile stopped early; the rest stay due for the next run", {
        ...result,
        reason: signal.aborted ? "stopping" : "rate_limited",
      });
    } else {
      log.info("entitlements reconciled", result);
    }
    if (failed > 0 && failed / checked >= RECONCILE_ALERT_FAILURE_RATE) {
      await alerter.alert(
        "entitlements-reconcile",
        `Entitlement reconcile: ${failed} of ${checked} RevenueCat checks failed${skipped > 0 ? ` (${skipped} more skipped)` : ""}. Their last known state was kept.`,
      );
    }
    return result;
  }

  async function settled(): Promise<void> {
    while (pending.size > 0) await Promise.allSettled(pending);
  }

  async function stop(): Promise<void> {
    stopping.abort();
    await settled();
  }

  return {
    deps,
    ensureCustomer,
    getCustomer,
    refreshIfStale,
    isEntitled,
    requirePro,
    refreshNow,
    refreshKnownInBackground,
    reconcile,
    settled,
    stop,
  };
}
