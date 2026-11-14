/**
 * AI usage accounting: one ai_calls row per provider call, the per-customer
 * monthly rollup (ai_usage_monthly), and the queries behind the monthly cap
 * and the global daily free budget.
 */
import type { Database } from "bun:sqlite";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { aiCalls, aiUsageMonthly } from "../../db/schema";
import { DAY_MS } from "../../lib/time";
import type { Db } from "../../types";
import type { AiFeature } from "./registry";

export const AI_CALLS_RETENTION_MS = 90 * DAY_MS;

/** 'YYYY-MM' in UTC, as v1 computed it. */
export function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** Midnight UTC of the day containing `now`. */
export function startOfUtcDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export interface CallRecord {
  ts: number;
  feature: AiFeature;
  model: string;
  customerId: string | null;
  clientKey: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  status: string;
  error: string | null;
}

/** Writes the ai_calls row and, for a customer, the monthly upsert, in one transaction. */
export function recordCall(db: Db, record: CallRecord): void {
  db.transaction((tx) => {
    tx.insert(aiCalls).values(record).run();
    if (record.customerId !== null) {
      tx.insert(aiUsageMonthly)
        .values({
          customerId: record.customerId,
          month: monthKey(record.ts),
          requestCount: 1,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          costUsd: record.costUsd,
        })
        .onConflictDoUpdate({
          target: [aiUsageMonthly.customerId, aiUsageMonthly.month],
          set: {
            requestCount: sql`${aiUsageMonthly.requestCount} + 1`,
            inputTokens: sql`${aiUsageMonthly.inputTokens} + ${record.inputTokens}`,
            outputTokens: sql`${aiUsageMonthly.outputTokens} + ${record.outputTokens}`,
            costUsd: sql`${aiUsageMonthly.costUsd} + ${record.costUsd}`,
          },
        })
        .run();
    }
  });
}

/** The customer's spend in the month containing `now`. */
export function monthSpendUsd(db: Db, customerId: string, now: number): number {
  const row = db
    .select({ costUsd: aiUsageMonthly.costUsd })
    .from(aiUsageMonthly)
    .where(and(eq(aiUsageMonthly.customerId, customerId), eq(aiUsageMonthly.month, monthKey(now))))
    .get();
  return row?.costUsd ?? 0;
}

/** Spend today (UTC) across the given features, from ai_calls. */
export function dailySpendUsd(db: Db, features: readonly AiFeature[], now: number): number {
  if (features.length === 0) return 0;
  const row = db
    .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` })
    .from(aiCalls)
    .where(and(inArray(aiCalls.feature, [...features]), gte(aiCalls.ts, startOfUtcDay(now))))
    .get();
  return row?.total ?? 0;
}

/** Calls today (UTC) of one feature from one client key (see clientKeyFor). */
export function dailyCallCount(db: Db, feature: AiFeature, clientKey: string, now: number): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(aiCalls)
    .where(
      and(
        eq(aiCalls.feature, feature),
        gte(aiCalls.ts, startOfUtcDay(now)),
        eq(aiCalls.clientKey, clientKey),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** Deletes ai_calls rows older than the retention window. Returns the count deleted. */
export function pruneCalls(
  sqlite: Database,
  now: number,
  retentionMs = AI_CALLS_RETENTION_MS,
): number {
  return sqlite.run("DELETE FROM ai_calls WHERE ts < ?", [now - retentionMs]).changes;
}
