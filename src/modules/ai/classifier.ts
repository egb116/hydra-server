/**
 * Post classifiers for filterPosts. The PostClassifier interface
 * (contracts.ts) is the seam for other backends, such as a decision model
 * (Jev, or the OpenAI Decisions API via ai's experimental_decide).
 */
import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import type { ClassifierPost, PostClassifier } from "../contracts";
import { AiCallError, normalizeUsage } from "./gateway";
import { FILTER_INSTRUCTIONS, filterPostsPrompt } from "./prompts/filterPosts";
import type { ProviderOptionsMap } from "./registry";

export type ClassifyInput = Parameters<PostClassifier["classify"]>[0];
export type ClassifyResult = Awaited<ReturnType<PostClassifier["classify"]>>;

/** A classify result that may also say how it was obtained (recorded in ai_calls.status). */
export interface ClassifyOutcome extends ClassifyResult {
  /** "ok", "repaired" (jsonrepair fallback) or "parse_error" (failed open: nothing hidden). */
  status?: string;
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
