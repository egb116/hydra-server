/**
 * runAI: the one path every AI provider call takes. It applies the gates
 * (Pro entitlement and monthly cap, or per-IP limiter and daily free budget),
 * runs the call, maps failures to HTTP errors, and records usage in a
 * `finally`, so a call that fails to parse is still paid for in the books.
 */
import { createHash } from "node:crypto";
import { AISDKError, APICallError, NoObjectGeneratedError } from "ai";
import { FailureRateAlert } from "../../lib/alert";
import { AppError, describeThrown, TooManyRequests, Upstream } from "../../lib/errors";
import { isAbortError } from "../../lib/http";
import { TokenBucket } from "../../lib/limiter";
import { DAY_MS } from "../../lib/time";
import type { Deps } from "../../types";
import type { EntitlementService } from "../contracts";
import {
  type AiFeature,
  type AiRegistry,
  costUsd,
  FREE_FEATURES,
  type FreeFeature,
  type ModelEntry,
} from "./registry";
import { clientNetworkKey } from "../../http/clientIp";
import { dailyCallCount, dailySpendUsd, monthSpendUsd, recordCall, startOfUtcDay } from "./usage";

/** Token counts with nulls normalized to 0. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What a call returns to runAI. */
export interface AiCallOutcome<T> {
  value: T;
  usage?: TokenUsage | null;
  /** Recorded in ai_calls.status. Default "ok". */
  status?: string;
  /**
   * Set when the call answered but mostly failed underneath (for example most
   * of a batch's provider calls errored and failed open). The request still
   * succeeds, but this counts as a failure toward the failure-rate alert and
   * is recorded in ai_calls.error, so a partial outage isn't silent.
   */
  degraded?: string;
}

/**
 * A provider call that failed after it may have consumed tokens (empty or
 * truncated output). runAI records its usage and answers 502.
 */
export class AiCallError extends Error {
  constructor(
    message: string,
    readonly status: string,
    readonly usage: TokenUsage | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AiCallError";
  }
}

interface RawUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** ai-sdk reports undefined token counts for some providers; those become 0. */
export function normalizeUsage(usage: RawUsage | null | undefined): TokenUsage {
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) };
}

export interface AiRequestContext {
  /** Required for Pro features (already validated by the route). */
  customerId?: string;
  /** The client IP; keys the free-feature limiter. */
  clientIp?: string;
  /** Aborts the provider call (for example when the client disconnects). */
  signal?: AbortSignal;
}

export interface AiCallArgs {
  entry: ModelEntry;
  signal: AbortSignal;
}

export interface AiGateway {
  readonly registry: AiRegistry;
  runAI<T>(
    feature: AiFeature,
    ctx: AiRequestContext,
    call: (args: AiCallArgs) => Promise<AiCallOutcome<T>>,
  ): Promise<T>;
}

export interface FreeLimit {
  /** Burst size per client network (see clientNetworkKey). */
  capacity: number;
  refillPerSecond: number;
  /**
   * Most calls per client network per UTC day, counted from ai_calls (so it
   * survives restarts). Null or absent means no daily cap.
   */
  dailyPerClient?: number | null;
}

/**
 * Per-client limits on the free features. The app makes one of each call per
 * guide search. The daily caps keep one client from spending the shared daily
 * free budget at the allowed refill rate.
 */
export const DEFAULT_FREE_LIMITS: Readonly<Record<FreeFeature, FreeLimit>> = {
  answerDocs: { capacity: 10, refillPerSecond: 1 / 30, dailyPerClient: 50 },
  embedQuery: { capacity: 20, refillPerSecond: 1 / 15, dailyPerClient: 200 },
};

/**
 * How AI_FREE_DAILY_BUDGET_USD is split between the free features. Each
 * feature is gated only by its own spend, so answerDocs spend can't lock out
 * createEmbedding (which the guide's search needs and which costs about
 * $0.00001 per call).
 */
export const DEFAULT_FREE_BUDGET_SHARES: Readonly<Record<FreeFeature, number>> = {
  answerDocs: 0.9,
  embedQuery: 0.1,
};

export const MONTHLY_LIMIT_MESSAGE = "Monthly usage limit exceeded";
export const THROTTLED_MESSAGE = "Throttled";
export const UPSTREAM_MESSAGE = "The AI provider failed. Please try again later.";
export const TIMEOUT_MESSAGE = "The AI provider timed out. Please try again later.";

export interface AiGatewayOptions {
  entitlements: EntitlementService;
  registry: AiRegistry;
  /** Merged over DEFAULT_FREE_LIMITS per feature. */
  freeLimits?: Partial<Record<AiFeature, Partial<FreeLimit>>>;
  /** Replaces DEFAULT_FREE_BUDGET_SHARES per feature. */
  freeBudgetShares?: Partial<Record<AiFeature, number>>;
}

/**
 * The client key stored in ai_calls.client_key: a sha256 prefix of the client
 * network (the IPv4 address, or the IPv6 /64), so the per-client daily caps
 * count every address of one /64 together.
 */
export function clientKeyFor(ip: string | undefined): string | null {
  if (ip === undefined) return null;
  const network = clientNetworkKey(ip);
  return `ip:${createHash("sha256").update(network).digest("hex").slice(0, 16)}`;
}

function secondsUntilUtcMidnight(now: number): number {
  return (startOfUtcDay(now) + DAY_MS - now) / 1000;
}

function errorStatus(err: unknown, signal: AbortSignal): string {
  if (err instanceof AiCallError) return err.status;
  if (signal.aborted || isAbortError(err)) return "timeout";
  if (NoObjectGeneratedError.isInstance(err)) return "parse_error";
  if (AISDKError.isInstance(err)) return "upstream_error";
  if (err instanceof AppError) return `http_${err.status}`;
  return "error";
}

function usageFromError(err: unknown): TokenUsage | null {
  if (err instanceof AiCallError) return err.usage;
  if (NoObjectGeneratedError.isInstance(err)) return normalizeUsage(err.usage);
  return null;
}

function isTimeout(err: unknown): boolean {
  if (isAbortError(err)) return true;
  return err instanceof Error && err.cause !== undefined && isAbortError(err.cause);
}

export function createAiGateway(
  deps: Pick<Deps, "db" | "clock" | "log" | "alerter" | "metrics" | "config">,
  options: AiGatewayOptions,
): AiGateway {
  const { registry, entitlements } = options;
  const buckets = new Map<AiFeature, TokenBucket>();
  const dailyCaps = new Map<AiFeature, number>();
  const budgetShares = new Map<AiFeature, number>();
  for (const feature of FREE_FEATURES) {
    const limit: FreeLimit = { ...DEFAULT_FREE_LIMITS[feature], ...options.freeLimits?.[feature] };
    buckets.set(
      feature,
      new TokenBucket({
        capacity: limit.capacity,
        refillPerSecond: limit.refillPerSecond,
        clock: deps.clock,
      }),
    );
    if (limit.dailyPerClient != null) dailyCaps.set(feature, limit.dailyPerClient);
    budgetShares.set(
      feature,
      options.freeBudgetShares?.[feature] ?? DEFAULT_FREE_BUDGET_SHARES[feature],
    );
  }
  const warnedUnpriced = new Set<string>();
  // Provider timeouts and errors alert on a failure rate per feature: one slow
  // or failed call is routine and must not page.
  const failureRate = new FailureRateAlert({ alerter: deps.alerter, clock: deps.clock });

  function gatePro(feature: AiFeature, customerId: string | undefined): string {
    if (customerId === undefined) {
      throw new Error(`runAI(${feature}): a Pro feature needs a customerId`);
    }
    entitlements.requirePro(customerId);
    const limit = deps.config.ai.monthlyLimitUsd;
    if (limit !== null && monthSpendUsd(deps.db, customerId, deps.clock.now()) >= limit) {
      deps.metrics.inc(`ai.monthly_limit.${feature}`);
      throw new TooManyRequests(MONTHLY_LIMIT_MESSAGE);
    }
    return customerId;
  }

  function gateFree(feature: AiFeature, ip: string | undefined): void {
    const now = deps.clock.now();
    const bucket = buckets.get(feature);
    if (bucket) {
      // Keyed by network, not address: one client owns a whole IPv6 /64.
      const taken = bucket.take(clientNetworkKey(ip ?? "unknown"));
      if (!taken.ok) {
        deps.metrics.inc(`ai.throttled.${feature}`);
        throw new TooManyRequests(THROTTLED_MESSAGE, {
          retryAfter: taken.retryAfterMs / 1000,
        });
      }
    }
    const cap = dailyCaps.get(feature);
    const clientKey = clientKeyFor(ip);
    if (cap !== undefined && clientKey !== null) {
      if (dailyCallCount(deps.db, feature, clientKey, now) >= cap) {
        deps.metrics.inc(`ai.daily_client_cap.${feature}`);
        throw new TooManyRequests(THROTTLED_MESSAGE, {
          retryAfter: secondsUntilUtcMidnight(now),
        });
      }
    }
    const budget = deps.config.ai.freeDailyBudgetUsd * (budgetShares.get(feature) ?? 1);
    const spent = dailySpendUsd(deps.db, [feature], now);
    if (spent >= budget) {
      deps.metrics.inc(`ai.free_budget_exhausted.${feature}`);
      void deps.alerter.alert(
        `ai-free-budget:${feature}`,
        `The daily free AI budget for ${feature} ($${budget.toFixed(2)} of AI_FREE_DAILY_BUDGET_USD) is used up ($${spent.toFixed(4)} spent today, UTC). It returns 429 until midnight UTC.`,
      );
      throw new TooManyRequests(THROTTLED_MESSAGE, {
        retryAfter: secondsUntilUtcMidnight(now),
      });
    }
  }

  return {
    registry,
    async runAI<T>(
      feature: AiFeature,
      ctx: AiRequestContext,
      call: (args: AiCallArgs) => Promise<AiCallOutcome<T>>,
    ): Promise<T> {
      const entry = registry[feature];
      const customerId = entry.tier === "pro" ? gatePro(feature, ctx.customerId) : null;
      if (entry.tier === "free") gateFree(feature, ctx.clientIp);

      const controller = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal;
      const started = deps.clock.now();
      let status = "error";
      let usage: TokenUsage | null = null;
      let errorText: string | null = null;
      try {
        const outcome = await call({ entry, signal });
        if (outcome.degraded) {
          errorText = outcome.degraded;
          deps.log.warn("ai call degraded", {
            feature,
            model: entry.modelId,
            error: outcome.degraded,
          });
          failureRate.failed(
            `ai-failures:${feature}`,
            `AI ${feature} mostly failed (${entry.modelId}): ${outcome.degraded}`,
          );
        } else {
          failureRate.succeeded(`ai-failures:${feature}`);
        }
        status = outcome.status ?? "ok";
        usage = outcome.usage ?? null;
        return outcome.value;
      } catch (err) {
        status = errorStatus(err, signal);
        usage = usageFromError(err);
        errorText = describeThrown(err);
        if (err instanceof AppError) throw err;
        const log = deps.log.child({ feature, model: entry.modelId });
        if (ctx.signal?.aborted) {
          status = "aborted";
          throw new Upstream(UPSTREAM_MESSAGE, { cause: err });
        }
        if (isTimeout(err)) {
          log.warn("ai call timed out", { err });
          failureRate.failed(
            `ai-failures:${feature}`,
            `AI ${feature} timed out (${entry.modelId}).`,
          );
          throw new Upstream(TIMEOUT_MESSAGE, { cause: err });
        }
        if (err instanceof AiCallError || AISDKError.isInstance(err)) {
          log.warn("ai call failed", { err, status });
          if (!(err instanceof AiCallError)) {
            const message = `AI ${feature} failed (${entry.modelId}): ${describeThrown(err)}`;
            // 401/403: a bad or revoked provider key fails every call; say so at once.
            if (
              APICallError.isInstance(err) &&
              (err.statusCode === 401 || err.statusCode === 403)
            ) {
              void deps.alerter.alert(`ai-auth:${feature}`, message);
            } else {
              failureRate.failed(`ai-failures:${feature}`, message);
            }
          }
          throw new Upstream(UPSTREAM_MESSAGE, { cause: err });
        }
        throw err;
      } finally {
        controller.abort();
        const now = deps.clock.now();
        const tokens = usage ?? { inputTokens: 0, outputTokens: 0 };
        const model = entry.modelId;
        const price =
          entry.inputUsdPerMTok === null && entry.outputUsdPerMTok === null ? null : entry;
        if (!price && !warnedUnpriced.has(model)) {
          warnedUnpriced.add(model);
          deps.log.warn("ai model has no known pricing; recording cost 0", { feature, model });
        }
        const cost = costUsd(price, tokens.inputTokens, tokens.outputTokens);
        try {
          recordCall(deps.db, {
            ts: now,
            feature,
            model,
            customerId,
            clientKey: clientKeyFor(ctx.clientIp),
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            costUsd: cost,
            latencyMs: Math.max(0, Math.round(now - started)),
            status,
            error: errorText,
          });
        } catch (recordErr) {
          deps.log.error("failed to record ai usage", { err: recordErr, feature, model });
        }
        deps.metrics.inc("ai.calls");
        deps.metrics.inc(`ai.calls.${feature}.${status}`);
        deps.metrics.inc("ai.cost_usd", cost);
      }
    },
  };
}
