import type { Heartbeat } from "../../lib/jobs";
import type { Deps } from "../../types";
import type { ProxyHealthSnapshot } from "../contracts";
import { monthKey } from "../ai/usage";
import { CLAIMABLE_FILTER, DUE_FILTER } from "../poller/poller";

/** Sources of live, in-process state the admin page shows. */
export interface AdminSources {
  /** JobRunner.heartbeats() */
  heartbeats: () => Record<string, Heartbeat>;
  /** ProxyPool.health() */
  proxyHealth: () => ProxyHealthSnapshot;
}

export interface MetricEntry {
  name: string;
  value: number;
}

export interface JobEntry extends Heartbeat {
  name: string;
}

export interface RecentAccountError {
  username: string;
  status: string;
  error: string;
  at: number;
  consecutiveFailures: number;
  sessionFailures: number;
}

export interface AiFeatureSpend {
  feature: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AiTopCustomer {
  /** Truncated: only the last few characters of the RevenueCat id. */
  customer: string;
  requests: number;
  costUsd: number;
}

export interface AdminStats {
  generatedAt: number;
  /** When this module was created (process boot, in practice). In-process metrics count from here. */
  bootedAt: number;
  mode: string;
  accounts: {
    total: number;
    active: number;
    needsReauth: number;
    /**
     * Accounts the poller would claim (or has claimed) right now: next_check_at <= now,
     * linked to a device and, in official mode, entitled. Leased accounts count.
     */
    dueNow: number;
    /**
     * now - min(next_check_at) over due, unleased, claimable accounts; 0 when nothing is
     * waiting. The same filter as the poller's claim and its `poller.lag_ms` gauge.
     */
    queueLagMs: number;
    /** The 50 most recent errors, newest first. */
    recentErrors: RecentAccountError[];
  };
  customers: {
    total: number;
    /** is_pro with no expiry or an expiry in the future. */
    pro: number;
    withDevices: number;
    devices: number;
  };
  /** Counters and gauges named `poller.*`. */
  poller: MetricEntry[];
  proxy: ProxyHealthSnapshot;
  jobs: JobEntry[];
  ai: {
    /** 'YYYY-MM' (UTC) */
    month: string;
    totalUsd: number;
    calls: number;
    /** From ai_calls, this month. */
    byFeature: AiFeatureSpend[];
    /** Customers with recorded AI usage this month (ai_usage_monthly). */
    customers: number;
    /** Top 10 by cost this month. */
    topCustomers: AiTopCustomer[];
  };
  push: {
    /** push_tickets rows still waiting for a receipt check. */
    pendingReceipts: number;
    oldestPendingAt: number | null;
    /** Counters and gauges named `push.*`. */
    metrics: MetricEntry[];
  };
  /** Every other in-process metric (http.*, reddit.*, ...). */
  otherMetrics: MetricEntry[];
}

export const RECENT_ERRORS_LIMIT = 50;
export const TOP_CUSTOMERS_LIMIT = 10;
/** Repeated requests within this window share one computation. */
export const STATS_CACHE_MS = 5_000;
const ERROR_TEXT_MAX_CHARS = 300;

/** Shows only the tail of a customer id: enough to tell rows apart and to grep logs. */
export function truncateCustomerId(id: string): string {
  return id.length > 8 ? `…${id.slice(-6)}` : id;
}

export function utcMonth(ms: number): { month: string; start: number } {
  const d = new Date(ms);
  return { month: monthKey(ms), start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
}

interface FeatureRow {
  feature: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  maxId: number;
}

export interface StatsCollector {
  collect(): AdminStats;
}

/**
 * Builds the admin stats. Every query reads an index or a small table:
 *
 * - due now / queue lag: `reddit_accounts(next_check_at)`, then a customers
 *   primary-key lookup and a `device_accounts(account_id)` probe per due row.
 * - status totals: one pass over reddit_accounts (no index on status needed at
 *   this size).
 * - recent errors: ORDER BY last_error_at LIMIT 50, an index walk of
 *   `reddit_accounts(last_error_at)`.
 * - AI spend by feature: the month is aggregated once via `ai_calls(ts)`, then
 *   only rows with a higher id than the month's newest are added on later
 *   calls, so a refresh costs an id range scan of the new calls (ids only grow:
 *   ai_calls.id is AUTOINCREMENT).
 * - top customers: `ai_usage_monthly(month, cost_usd)`.
 *
 * Results are cached for STATS_CACHE_MS so several open tabs cost one query set.
 */
export function createStatsCollector(
  deps: Pick<Deps, "sqlite" | "clock" | "metrics" | "config">,
  sources: AdminSources,
): StatsCollector {
  const { sqlite, clock } = deps;
  const bootedAt = clock.now();

  const q = {
    statusCounts: sqlite.query<{ status: string; n: number }, []>(
      "SELECT status, COUNT(*) AS n FROM reddit_accounts GROUP BY status",
    ),
    due: sqlite.query<{ n: number }, { now: number; selfhost: number }>(
      `SELECT COUNT(*) AS n FROM reddit_accounts a JOIN customers c ON c.id = a.customer_id
       WHERE ${CLAIMABLE_FILTER}`,
    ),
    oldestWaiting: sqlite.query<{ at: number | null }, { now: number; selfhost: number }>(
      `SELECT MIN(a.next_check_at) AS at FROM reddit_accounts a JOIN customers c ON c.id = a.customer_id
       WHERE ${DUE_FILTER}`,
    ),
    recentErrors: sqlite.query<
      {
        username: string;
        status: string;
        error: string | null;
        at: number;
        consecutiveFailures: number;
        sessionFailures: number;
      },
      [number]
    >(
      `SELECT username, status, last_error AS error, last_error_at AS at,
              consecutive_failures AS consecutiveFailures, session_failures AS sessionFailures
       FROM reddit_accounts WHERE last_error_at IS NOT NULL
       ORDER BY last_error_at DESC LIMIT ?1`,
    ),
    customers: sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM customers"),
    pro: sqlite.query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM customers
       WHERE is_pro = 1 AND (pro_expires_at IS NULL OR pro_expires_at > ?1)`,
    ),
    devices: sqlite.query<{ n: number; customers: number }, []>(
      "SELECT COUNT(*) AS n, COUNT(DISTINCT customer_id) AS customers FROM devices",
    ),
    featureMonth: sqlite.query<FeatureRow, [number]>(
      `SELECT feature, COUNT(*) AS calls, SUM(error IS NOT NULL) AS errors,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              SUM(cost_usd) AS costUsd, MAX(id) AS maxId
       FROM ai_calls WHERE ts >= ?1 GROUP BY feature`,
    ),
    featureSince: sqlite.query<FeatureRow, [number, number]>(
      `SELECT feature, COUNT(*) AS calls, SUM(error IS NOT NULL) AS errors,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              SUM(cost_usd) AS costUsd, MAX(id) AS maxId
       FROM ai_calls WHERE id > ?1 AND ts >= ?2 GROUP BY feature`,
    ),
    usageTotals: sqlite.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM ai_usage_monthly WHERE month = ?1",
    ),
    topCustomers: sqlite.query<
      { customerId: string; requests: number; costUsd: number },
      [string, number]
    >(
      `SELECT customer_id AS customerId, request_count AS requests, cost_usd AS costUsd
       FROM ai_usage_monthly WHERE month = ?1 ORDER BY cost_usd DESC LIMIT ?2`,
    ),
    tickets: sqlite.query<{ n: number; oldest: number | null }, []>(
      "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM push_tickets",
    ),
  };

  // Incremental AI spend for the current month.
  let aiMonthStart = -1;
  let aiMaxId = 0;
  const aiByFeature = new Map<string, AiFeatureSpend>();

  function addFeatureRows(rows: FeatureRow[]): void {
    for (const row of rows) {
      const current = aiByFeature.get(row.feature) ?? {
        feature: row.feature,
        calls: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      current.calls += row.calls;
      current.errors += row.errors ?? 0;
      current.inputTokens += row.inputTokens ?? 0;
      current.outputTokens += row.outputTokens ?? 0;
      current.costUsd += row.costUsd ?? 0;
      aiByFeature.set(row.feature, current);
      if (row.maxId > aiMaxId) aiMaxId = row.maxId;
    }
  }

  function aiSpend(monthStart: number): AiFeatureSpend[] {
    // A new month, or no rows yet this month (the ts index is then the cheap
    // path): aggregate the whole month.
    if (monthStart !== aiMonthStart || aiMaxId === 0) {
      aiMonthStart = monthStart;
      aiByFeature.clear();
      aiMaxId = 0;
      addFeatureRows(q.featureMonth.all(monthStart));
    } else {
      addFeatureRows(q.featureSince.all(aiMaxId, monthStart));
    }
    return [...aiByFeature.values()]
      .map((f) => ({ ...f }))
      .sort((a, b) => b.costUsd - a.costUsd || a.feature.localeCompare(b.feature));
  }

  function splitMetrics(): { poller: MetricEntry[]; push: MetricEntry[]; other: MetricEntry[] } {
    const out = {
      poller: [] as MetricEntry[],
      push: [] as MetricEntry[],
      other: [] as MetricEntry[],
    };
    for (const [name, value] of Object.entries(deps.metrics.snapshot())) {
      const entry = { name, value };
      if (name.startsWith("poller.")) out.poller.push(entry);
      else if (name.startsWith("push.")) out.push.push(entry);
      else out.other.push(entry);
    }
    return out;
  }

  function compute(now: number): AdminStats {
    let active = 0;
    let needsReauth = 0;
    let total = 0;
    for (const row of q.statusCounts.all()) {
      total += row.n;
      if (row.status === "active") active += row.n;
      else if (row.status === "needs_reauth") needsReauth += row.n;
    }
    const claimable = { now, selfhost: deps.config.mode === "selfhost" ? 1 : 0 };
    const oldestWaiting = q.oldestWaiting.get(claimable)?.at ?? null;
    const devices = q.devices.get();
    const { month, start } = utcMonth(now);
    const byFeature = aiSpend(start);
    const tickets = q.tickets.get();
    const metrics = splitMetrics();
    const heartbeats = sources.heartbeats();

    return {
      generatedAt: now,
      bootedAt,
      mode: deps.config.mode,
      accounts: {
        total,
        active,
        needsReauth,
        dueNow: q.due.get(claimable)?.n ?? 0,
        queueLagMs: oldestWaiting === null ? 0 : Math.max(0, now - oldestWaiting),
        recentErrors: q.recentErrors.all(RECENT_ERRORS_LIMIT).map((row) => ({
          ...row,
          error: (row.error ?? "").slice(0, ERROR_TEXT_MAX_CHARS),
        })),
      },
      customers: {
        total: q.customers.get()?.n ?? 0,
        pro: q.pro.get(now)?.n ?? 0,
        withDevices: devices?.customers ?? 0,
        devices: devices?.n ?? 0,
      },
      poller: metrics.poller,
      proxy: sources.proxyHealth(),
      jobs: Object.entries(heartbeats)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, heartbeat]) => ({ name, ...heartbeat })),
      ai: {
        month,
        totalUsd: byFeature.reduce((sum, f) => sum + f.costUsd, 0),
        calls: byFeature.reduce((sum, f) => sum + f.calls, 0),
        byFeature,
        customers: q.usageTotals.get(month)?.n ?? 0,
        topCustomers: q.topCustomers.all(month, TOP_CUSTOMERS_LIMIT).map((row) => ({
          customer: truncateCustomerId(row.customerId),
          requests: row.requests,
          costUsd: row.costUsd,
        })),
      },
      push: {
        pendingReceipts: tickets?.n ?? 0,
        oldestPendingAt: tickets?.oldest ?? null,
        metrics: metrics.push,
      },
      otherMetrics: metrics.other,
    };
  }

  let cached: AdminStats | null = null;
  return {
    collect() {
      const now = clock.now();
      if (
        cached !== null &&
        now >= cached.generatedAt &&
        now - cached.generatedAt < STATS_CACHE_MS
      ) {
        return cached;
      }
      cached = compute(now);
      return cached;
    },
  };
}
