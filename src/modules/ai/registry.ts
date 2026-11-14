/**
 * The AI model registry: which model serves each feature, what it costs, and
 * how it is called. Defaults reproduce v1's per-provider model choices
 * (routes/ai/*.ts); pricing comes from v1's services/AIUsage.ts.
 */
import type { JSONValue } from "ai";
import type { AiProvider, Config, HydraMode } from "../../config";

export const AI_FEATURES = [
  "summarizePost",
  "summarizeComments",
  "filterPosts",
  "answerDocs",
  "embedQuery",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

/** The features anyone can call; the rest need Pro. */
export const FREE_FEATURES = ["answerDocs", "embedQuery"] as const satisfies readonly AiFeature[];
export type FreeFeature = (typeof FREE_FEATURES)[number];

function isFree(feature: AiFeature): feature is FreeFeature {
  return (FREE_FEATURES as readonly AiFeature[]).includes(feature);
}

/** Pro features are gated by the entitlement and the monthly cap; free ones by IP and the daily budget. */
export type AiTier = "pro" | "free";

export type ProviderOptionsMap = Record<string, Record<string, JSONValue>>;

/** TypeSafe AI serves the Jev decision model, used for filterPosts when TYPESAFE_AI_API_KEY is set. */
export type ModelProvider = AiProvider | "typesafe";

export interface ModelEntry {
  feature: AiFeature;
  /** "openai" for the embedding model regardless of AI_PROVIDER (v1 behaviour). */
  provider: ModelProvider;
  kind: "language" | "embedding" | "decision";
  modelId: string;
  /** USD per million input tokens. Null when the price is unknown (selfhost only). */
  inputUsdPerMTok: number | null;
  outputUsdPerMTok: number | null;
  /** Null for embeddings. */
  maxOutputTokens: number | null;
  providerOptions: ProviderOptionsMap;
  /** Per HTTP request to the provider. */
  timeoutMs: number;
  tier: AiTier;
}

export type AiRegistry = Readonly<Record<AiFeature, Readonly<ModelEntry>>>;

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/**
 * Known list prices (USD per million tokens, uncached input), keyed by the
 * model id as sent to the provider. The gpt-oss rows are Groq's as of 2026-11
 * (console.groq.com/docs/model/openai/gpt-oss-20b and …/gpt-oss-120b).
 * Recorded spend is real spend, so AI_MONTHLY_LIMIT_USD is a real-dollar cap.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "llama-3.1-8b-instant": { inputUsdPerMTok: 0.05, outputUsdPerMTok: 0.08 },
  "openai/gpt-oss-20b": { inputUsdPerMTok: 0.075, outputUsdPerMTok: 0.3 },
  "openai/gpt-oss-120b": { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  "openai/gpt-4.1-mini": { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6 },
  "gpt-4.1-mini": { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6 },
  "openai/gpt-4.1": { inputUsdPerMTok: 2.0, outputUsdPerMTok: 8.0 },
  "gpt-4.1": { inputUsdPerMTok: 2.0, outputUsdPerMTok: 8.0 },
  "text-embedding-3-small": { inputUsdPerMTok: 0.02, outputUsdPerMTok: 0 },
  // docs.typesafe.ai/models, 2026-11: $42 per billion input tokens; output is free.
  "jev-1.14.0": { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 },
};

export const EMBEDDING_MODEL_ID = "text-embedding-3-small";

/**
 * The Jev version for filterPosts. Pinned, not "jev-latest": the default
 * sensitivity is tuned against one version's probabilities, and a silent model
 * change could move them. Re-run `bun scripts/eval-filter.ts --classifier jev
 * --sweep` before bumping it.
 */
export const JEV_MODEL_ID = "jev-1.14.0";
/** Per Jev request. A decision call is one short classification, not generation. */
export const JEV_TIMEOUT_MS = 10_000;

/**
 * v1's model choices per provider, except that the OpenAI ids are the bare
 * ones api.openai.com accepts ("gpt-4.1-mini", not "openai/gpt-4.1-mini").
 */
export const DEFAULT_MODELS: Readonly<
  Record<AiProvider, { summary: string; filter: string; answer: string }>
> = {
  groq: {
    summary: "openai/gpt-oss-20b",
    filter: "openai/gpt-oss-20b",
    answer: "openai/gpt-oss-120b",
  },
  openai: {
    summary: "gpt-4.1-mini",
    filter: "gpt-4.1-mini",
    answer: "gpt-4.1-mini",
  },
};

interface FeatureSpec {
  slot: "summary" | "filter" | "answer" | "embedding";
  maxOutputTokens: number | null;
  timeoutMs: number;
}

const FEATURE_SPECS: Readonly<Record<AiFeature, FeatureSpec>> = {
  // v1 capped summaries and the filter at 1,000 output tokens. The filter gets
  // more room because reasoning tokens count against the cap on gpt-oss and a
  // full page can list many indices.
  summarizePost: { slot: "summary", maxOutputTokens: 1_000, timeoutMs: 25_000 },
  summarizeComments: { slot: "summary", maxOutputTokens: 1_000, timeoutMs: 25_000 },
  filterPosts: { slot: "filter", maxOutputTokens: 2_000, timeoutMs: 25_000 },
  answerDocs: { slot: "answer", maxOutputTokens: 1_500, timeoutMs: 25_000 },
  embedQuery: { slot: "embedding", maxOutputTokens: null, timeoutMs: 10_000 },
};

export function isGptOss(modelId: string): boolean {
  return /(^|\/)gpt-oss-/.test(modelId);
}

/** Provider options for a language model, keyed by provider name. */
export function providerOptionsFor(
  provider: AiProvider,
  modelId: string,
  feature: AiFeature,
): ProviderOptionsMap {
  if (provider !== "groq") return {};
  const groq: Record<string, JSONValue> = {};
  if (isGptOss(modelId)) groq["reasoningEffort"] = "low";
  // Groq supports json_schema response formats on gpt-oss. Other models get
  // json_object mode; the filter prompt spells out the JSON shape either way.
  if (feature === "filterPosts" && !isGptOss(modelId)) {
    groq["structuredOutputs"] = false;
    groq["strictJsonSchema"] = false;
  }
  return Object.keys(groq).length > 0 ? { groq } : {};
}

/** filterPosts on the Jev decision model. Its price is always known. */
function jevEntry(): ModelEntry {
  const price = MODEL_PRICES[JEV_MODEL_ID];
  return Object.freeze({
    feature: "filterPosts",
    provider: "typesafe",
    kind: "decision",
    modelId: JEV_MODEL_ID,
    inputUsdPerMTok: price?.inputUsdPerMTok ?? null,
    outputUsdPerMTok: price?.outputUsdPerMTok ?? null,
    maxOutputTokens: null,
    providerOptions: {},
    timeoutMs: JEV_TIMEOUT_MS,
    tier: "pro",
  });
}

export function priceFor(modelId: string): ModelPrice | null {
  return Object.hasOwn(MODEL_PRICES, modelId) ? (MODEL_PRICES[modelId] ?? null) : null;
}

export class AiRegistryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid AI model configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "AiRegistryError";
  }
}

export interface BuiltRegistry {
  registry: AiRegistry;
  /** Non-fatal problems (selfhost mode) to log at boot. */
  warnings: string[];
}

/**
 * Resolves each feature's model from the config overrides and the provider
 * defaults. In official mode every model must have a known price, or this
 * throws (boot fails). In selfhost mode an unknown price is a warning and the
 * call is recorded at cost 0.
 */
export function buildAiRegistry(
  ai: Pick<Config["ai"], "provider" | "models"> & { typesafeApiKey?: string | null },
  mode: HydraMode,
): BuiltRegistry {
  const defaults = DEFAULT_MODELS[ai.provider];
  const problems: string[] = [];
  const warnings: string[] = [];
  const entryFor = (feature: AiFeature): ModelEntry => {
    if (feature === "filterPosts" && ai.typesafeApiKey) return jevEntry();
    const spec = FEATURE_SPECS[feature];
    const isEmbedding = spec.slot === "embedding";
    const provider: AiProvider = isEmbedding ? "openai" : ai.provider;
    const modelId =
      spec.slot === "embedding"
        ? EMBEDDING_MODEL_ID
        : (ai.models[spec.slot] ?? defaults[spec.slot]).trim();
    const price = priceFor(modelId);
    if (!price) {
      const message = `${feature}: no known pricing for model "${modelId}"`;
      if (mode === "official") problems.push(`${message} (add it to MODEL_PRICES)`);
      else warnings.push(`${message}; its usage is recorded at cost 0`);
    }
    return Object.freeze({
      feature,
      provider,
      kind: isEmbedding ? "embedding" : "language",
      modelId,
      inputUsdPerMTok: price?.inputUsdPerMTok ?? null,
      outputUsdPerMTok: price?.outputUsdPerMTok ?? null,
      maxOutputTokens: spec.maxOutputTokens,
      providerOptions: isEmbedding ? {} : providerOptionsFor(provider, modelId, feature),
      timeoutMs: spec.timeoutMs,
      tier: isFree(feature) ? "free" : "pro",
    });
  };
  const registry: AiRegistry = Object.freeze({
    summarizePost: entryFor("summarizePost"),
    summarizeComments: entryFor("summarizeComments"),
    filterPosts: entryFor("filterPosts"),
    answerDocs: entryFor("answerDocs"),
    embedQuery: entryFor("embedQuery"),
  });
  if (problems.length > 0) throw new AiRegistryError(problems);
  return { registry, warnings };
}

/** USD cost of a call. Unknown prices cost 0. */
export function costUsd(
  price: { inputUsdPerMTok: number | null; outputUsdPerMTok: number | null } | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!price) return 0;
  return (
    (inputTokens * (price.inputUsdPerMTok ?? 0) + outputTokens * (price.outputUsdPerMTok ?? 0)) /
    1_000_000
  );
}
