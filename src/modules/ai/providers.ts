/**
 * Builds ai-sdk models whose HTTP goes through deps.fetch (OutboundFetch), so
 * every provider call has a deadline and tests can fake the upstream.
 */
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { Config } from "../../config";
import { Unavailable } from "../../lib/errors";
import type { OutboundFetch, OutboundInit } from "../../lib/http";
import type { AiFeature, ModelEntry } from "./registry";

export type ProviderFetch = typeof globalThis.fetch;

/**
 * Adapts OutboundFetch to the `fetch` option that ai-sdk providers take.
 * Each request gets `timeoutMs`; the provider's own abort signal is kept.
 */
export function toProviderFetch(fetch: OutboundFetch, timeoutMs: number): ProviderFetch {
  const adapted = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url: string | URL;
    let base: RequestInit = {};
    if (input instanceof Request) {
      url = input.url;
      base = {
        method: input.method,
        headers: input.headers,
        body: input.body === null ? null : await input.text(),
        signal: input.signal,
      };
    } else {
      url = input;
    }
    const { signal, ...rest } = { ...base, ...init };
    const outbound: OutboundInit = { ...rest, timeoutMs };
    if (signal) outbound.signal = signal;
    return fetch(url, outbound);
  };
  return Object.assign(adapted, {
    preconnect: (): void => {},
  }) as ProviderFetch;
}

/** Turns registry entries into ai-sdk models. Injectable for tests. */
export interface AiModelFactory {
  /** Throws Unavailable when the provider has no API key. */
  languageModel(entry: ModelEntry): LanguageModel;
  /** Throws Unavailable when OPENAI_API_KEY is missing. */
  embeddingModel(entry: ModelEntry): EmbeddingModel;
}

export const AI_NOT_CONFIGURED = "AI is not configured on this server";
export const EMBEDDINGS_NOT_CONFIGURED = "Embeddings are not configured on this server";

/**
 * The real providers. Models are cached per feature because each feature has
 * its own request timeout baked into its fetch adapter.
 */
export function createProviderModelFactory(
  ai: Pick<Config["ai"], "groqApiKey" | "openaiApiKey" | "openaiBaseUrl">,
  fetch: OutboundFetch,
): AiModelFactory {
  const languageCache = new Map<AiFeature, LanguageModel>();
  const embeddingCache = new Map<AiFeature, EmbeddingModel>();
  return {
    languageModel(entry) {
      const cached = languageCache.get(entry.feature);
      if (cached) return cached;
      const providerFetch = toProviderFetch(fetch, entry.timeoutMs);
      let model: LanguageModel;
      if (entry.provider === "groq") {
        if (!ai.groqApiKey) throw new Unavailable(AI_NOT_CONFIGURED);
        model = createGroq({ apiKey: ai.groqApiKey, fetch: providerFetch })(entry.modelId);
      } else {
        if (!ai.openaiApiKey) throw new Unavailable(AI_NOT_CONFIGURED);
        // Chat Completions, not the provider's default Responses API:
        // AI_PROVIDER=openai promises any OpenAI-compatible base URL,
        // and most compatible servers (vLLM, Ollama, LM Studio) only implement
        // /chat/completions. api.openai.com serves both.
        model = createOpenAI({
          apiKey: ai.openaiApiKey,
          ...(ai.openaiBaseUrl ? { baseURL: ai.openaiBaseUrl } : {}),
          fetch: providerFetch,
        }).chat(entry.modelId);
      }
      languageCache.set(entry.feature, model);
      return model;
    },
    embeddingModel(entry) {
      const cached = embeddingCache.get(entry.feature);
      if (cached) return cached;
      if (!ai.openaiApiKey) throw new Unavailable(EMBEDDINGS_NOT_CONFIGURED);
      // v1 always embedded with api.openai.com, ignoring OPENAI_BASE_URL.
      const model = createOpenAI({
        apiKey: ai.openaiApiKey,
        fetch: toProviderFetch(fetch, entry.timeoutMs),
      }).embedding(entry.modelId);
      embeddingCache.set(entry.feature, model);
      return model;
    },
  };
}
