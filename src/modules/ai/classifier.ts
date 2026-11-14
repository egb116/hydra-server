/**
 * Post classifiers for filterPosts, behind the PostClassifier interface
 * (contracts.ts): JevPostClassifier (TypeSafe AI's Jev decision model, when
 * TYPESAFE_AI_API_KEY is set) and LlmPostClassifier (AI_PROVIDER's model).
 */
import {
  experimental_decide,
  type Experimental_DecisionModel,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  Output,
} from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { describeThrown } from "../../lib/errors";
import type { ClassifierPost, PostClassifier } from "../contracts";
import { AiCallError, normalizeUsage } from "./gateway";
import {
  FILTER_INSTRUCTIONS,
  filterDecisionQuestion,
  filterDecisionState,
  filterPostsPrompt,
  filterQuestionId,
} from "./prompts/filterPosts";
import type { ProviderOptionsMap } from "./registry";

export type ClassifyInput = Parameters<PostClassifier["classify"]>[0];
export type ClassifyResult = Awaited<ReturnType<PostClassifier["classify"]>>;

/** A classify result that may also say how it was obtained (recorded in ai_calls.status). */
export interface ClassifyOutcome extends ClassifyResult {
  /**
   * "ok"; "repaired" (jsonrepair fallback) or "parse_error" (failed open:
   * nothing hidden) for the LLM; "partial" when some posts couldn't be scored
   * and were left visible.
   */
  status?: string;
  /** Set when most of the work failed underneath; see AiCallOutcome.degraded. */
  degraded?: string;
}

/**
 * The sensitivity for requests that don't send one (every app build before
 * the setting existed): hide posts more likely than not to match. Measured
 * with batched calls on jev-1.14.0 (2026-11-14): on the synthetic eval cases
 * 0.4-0.6 all gave 99% F1; on 25-post pages 0.5 gave the best F1 (97%, every
 * post that should be hidden was), and 0.6 started hiding more that should show.
 */
export const DEFAULT_FILTER_SENSITIVITY = 0.5;

/**
 * Posts whose match probability is above this are hidden. Sensitivity 0
 * hides nothing (no probability is above 1); 1 hides anything with a
 * probability above 0.
 *
 * Rounded to 6 decimals: in floating point 1 - 0.9 is 0.0999…, which would
 * hide a post scored exactly 0.10 (TypeSafe rounds to 2 decimals) at
 * sensitivity 0.9 but not one scored 0.40 at 0.6. Rounding makes "above"
 * mean the same at every sensitivity, and the eval's sweep uses this too.
 */
export function hideThreshold(sensitivity: number | undefined): number {
  const s = sensitivity ?? DEFAULT_FILTER_SENSITIVITY;
  return Math.round((1 - Math.min(1, Math.max(0, s))) * 1e6) / 1e6;
}

/**
 * Posts per decision call. The app sends one page of at most 25 posts, so a
 * page is always one call; the schema allows up to 200, which become 4 calls.
 * A real page (25 posts, at most 500 chars of text each) is a few thousand
 * tokens. The worst case the schema allows (50 posts with 1,000-char titles
 * and texts, a 10,000-char description) is close to Jev's 32k-token limit per
 * question; a call over it fails and its posts stay visible.
 */
export const JEV_BATCH_SIZE = 50;
/** Batches in flight per request: enough that 200 posts (4 batches) run at once. */
export const JEV_CONCURRENCY = 4;

/**
 * More than this share of a request's posts failing makes the result
 * "degraded": still answered (those posts stay visible), but counted as a
 * failure for alerting.
 */
export const JEV_DEGRADED_SHARE = 0.5;

export interface JevPostClassifierOptions {
  model: Experimental_DecisionModel;
  /** Time limit for the whole request. Batches run in parallel, so one call plus a retry. */
  timeoutMs: number;
  batchSize?: number;
  concurrency?: number;
  maxRetries?: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  // One shared iterator: each worker takes the next item when it's free.
  const queue = items[Symbol.iterator]();
  const worker = async (): Promise<void> => {
    for (let step = queue.next(); step.done !== true; step = queue.next()) {
      await fn(step.value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The decision-model classifier. Each batch of up to JEV_BATCH_SIZE posts is
 * one call: the reader's description and the posts go in the state once, and
 * each post gets its own boolean question (does it match?). See
 * filterDecisionState for why this layout.
 *
 * Fails open: posts whose batch fails stay visible and the result is
 * "partial". There is no per-post retry: a failed batch (including one where
 * the model refused or skipped a single post) leaves its posts unfiltered.
 * When every post fails the error surfaces (so a revoked key or an outage is
 * reported like any other provider failure); when more than half fail the
 * result is "degraded", which counts toward the failure-rate alert.
 */
export class JevPostClassifier implements PostClassifier {
  readonly name = "jev";

  constructor(private readonly options: JevPostClassifierOptions) {}

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<ClassifyOutcome> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]);
    const scores = new Map<number, number>();
    const usage = { inputTokens: 0, outputTokens: 0 };
    let failedPosts = 0;
    let firstError: unknown;
    const fail = (count: number, err: unknown): void => {
      failedPosts += count;
      firstError ??= err;
    };

    /** Decides one batch, recording its scores and usage. Throws on failure. */
    const decideBatch = async (posts: readonly ClassifierPost[]): Promise<void> => {
      deadline.throwIfAborted();
      const result = await experimental_decide({
        model: this.options.model,
        state: filterDecisionState(input.description, posts),
        questions: Object.fromEntries(
          posts.map((post) => [filterQuestionId(post), filterDecisionQuestion(post)]),
        ),
        maxRetries: this.options.maxRetries ?? 1,
        abortSignal: deadline,
      });
      const used = normalizeUsage(result.usage);
      usage.inputTokens += used.inputTokens;
      usage.outputTokens += used.outputTokens;
      for (const post of posts) {
        const answer = result.answers[filterQuestionId(post)];
        if (answer?.type === "boolean") scores.set(post.index, answer.probability);
      }
    };

    const batches = chunk(input.posts, this.options.batchSize ?? JEV_BATCH_SIZE);
    await forEachLimit(batches, this.options.concurrency ?? JEV_CONCURRENCY, async (batch) => {
      try {
        await decideBatch(batch);
      } catch (err) {
        fail(batch.length, err);
      }
    });
    if (input.posts.length > 0 && failedPosts === input.posts.length) throw firstError;
    const threshold = hideThreshold(input.sensitivity);
    const hide = new Set<number>();
    for (const [index, probability] of scores) {
      if (probability > threshold) hide.add(index);
    }
    const outcome: ClassifyOutcome = {
      hide,
      usage,
      scores,
      status: failedPosts > 0 ? "partial" : "ok",
    };
    if (failedPosts > input.posts.length * JEV_DEGRADED_SHARE) {
      outcome.degraded = `${failedPosts} of ${input.posts.length} posts failed (first: ${describeThrown(firstError)})`;
    }
    return outcome;
  }
}

export const hideSchema = z.object({ hide: z.array(z.number().int()) });

/**
 * Keeps only valid, in-range integer indices. Anything else is dropped, which
 * fails open (the post stays visible).
 */
export function sanitizeHide(values: readonly unknown[], postCount: number): Set<number> {
  const hide = new Set<number>();
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < postCount) {
      hide.add(value);
    }
  }
  return hide;
}

/**
 * The last-resort parser for output that failed structured parsing: repairs
 * the JSON (jsonrepair), then accepts `{"hide":[...]}`, a bare array of
 * indices, or a `{"<index>": true}` map. Returns null when nothing usable is
 * found.
 */
export function parseHideLenient(text: string, postCount: number): Set<number> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // Models sometimes wrap JSON in prose or a code fence; start at the first bracket.
  const start = trimmed.search(/[[{]/);
  if (start === -1) return null;
  let value: unknown;
  try {
    value = JSON.parse(jsonrepair(trimmed.slice(start)));
  } catch {
    return null;
  }
  if (Array.isArray(value)) return sanitizeHide(value, postCount);
  if (value !== null && typeof value === "object") {
    if ("hide" in value && Array.isArray(value.hide)) return sanitizeHide(value.hide, postCount);
    const fromMap = Object.entries(value)
      .filter(([, flag]) => flag === true)
      .map(([key]) => (/^\d+$/.test(key) ? Number(key) : Number.NaN));
    if (fromMap.length > 0) return sanitizeHide(fromMap, postCount);
    if (Object.keys(value).length === 0) return new Set();
  }
  return null;
}

export interface LlmPostClassifierOptions {
  model: LanguageModel;
  maxOutputTokens: number;
  providerOptions?: ProviderOptionsMap;
  /** Total deadline for the call, including the one retry. */
  timeoutMs: number;
  maxRetries?: number;
}

/**
 * The default classifier: one LLM call with structured output
 * (`{hide: number[]}`), and jsonrepair as the last-resort fallback when the
 * structured parse fails. Unparseable output fails open (nothing hidden);
 * empty output throws an AiCallError (502) that carries the usage.
 */
export class LlmPostClassifier implements PostClassifier {
  readonly name = "llm";

  constructor(private readonly options: LlmPostClassifierOptions) {}

  async classify(input: ClassifyInput, signal: AbortSignal): Promise<ClassifyOutcome> {
    const { model, maxOutputTokens, providerOptions, timeoutMs } = this.options;
    const postCount = input.posts.length;
    let text: string;
    let usage: { inputTokens: number; outputTokens: number };
    let finishReason: string | undefined;
    try {
      const result = await generateText({
        model,
        instructions: FILTER_INSTRUCTIONS,
        prompt: filterPostsPrompt(input),
        output: Output.object({ schema: hideSchema, name: "filter_result" }),
        maxOutputTokens,
        maxRetries: this.options.maxRetries ?? 1,
        timeout: timeoutMs,
        abortSignal: signal,
        ...(providerOptions ? { providerOptions } : {}),
      });
      usage = normalizeUsage(result.usage);
      text = result.text;
      finishReason = result.finishReason;
      if (text.trim() !== "") {
        try {
          return { hide: sanitizeHide(result.output.hide, postCount), usage, status: "ok" };
        } catch {
          // No parsed output (for example finishReason "length"): repair below.
        }
      }
    } catch (err) {
      if (!NoObjectGeneratedError.isInstance(err)) throw err;
      usage = normalizeUsage(err.usage);
      text = err.text ?? "";
      finishReason = err.finishReason;
    }
    if (text.trim() === "") {
      const status = finishReason === "length" ? "truncated" : "empty";
      throw new AiCallError(
        `filter model returned no output (${finishReason ?? "unknown"})`,
        status,
        usage,
      );
    }
    const repaired = parseHideLenient(text, postCount);
    if (repaired) return { hide: repaired, usage, status: "repaired" };
    return { hide: new Set(), usage, status: "parse_error" };
  }
}

/** Maps request posts to classifier posts with server-assigned indices. */
export function toClassifierPosts(
  posts: readonly { title: string; text?: string | undefined; subreddit?: string | undefined }[],
): ClassifierPost[] {
  return posts.map((post, index) => {
    const out: ClassifierPost = { index, title: post.title };
    if (post.text !== undefined) out.body = post.text;
    if (post.subreddit !== undefined) out.subreddit = post.subreddit;
    return out;
  });
}
