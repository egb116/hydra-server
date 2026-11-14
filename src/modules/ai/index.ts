/**
 * The ai module: model registry, runAI gateway, usage accounting, prompts,
 * the five legacy /api/ai/* routes and the filter classifier seam.
 */
import type { Deps, Module } from "../../types";
import type { EntitlementService, PostClassifier } from "../contracts";
import { LlmPostClassifier } from "./classifier";
import { createAiGateway, type FreeLimit } from "./gateway";
import { type AiModelFactory, createProviderModelFactory } from "./providers";
import { type AiFeature, buildAiRegistry } from "./registry";
import { registerAiRoutes, totalTimeoutMs } from "./routes";
import { pruneCalls } from "./usage";

export { LlmPostClassifier, parseHideLenient, sanitizeHide, toClassifierPosts } from "./classifier";
export {
  AiCallError,
  createAiGateway,
  clientKeyFor,
  DEFAULT_FREE_LIMITS,
  normalizeUsage,
} from "./gateway";
export { createProviderModelFactory, toProviderFetch } from "./providers";
export { AiRegistryError, buildAiRegistry, costUsd, DEFAULT_MODELS } from "./registry";

export interface AiModuleOptions {
  entitlements: EntitlementService;
  /**
   * The filterPosts backend. Defaults to an LlmPostClassifier over the
   * registry's filter model. This is where a decision-model backend (Jev, or
   * the OpenAI Decisions API) plugs in once it has a config switch.
   */
  classifier?: PostClassifier;
  /** Builds ai-sdk models. Defaults to the real providers over deps.fetch. Tests inject mocks. */
  models?: AiModelFactory;
  /** Per-client limits for the free features (answerDocs, embedQuery), merged over DEFAULT_FREE_LIMITS. */
  freeLimits?: Partial<Record<AiFeature, Partial<FreeLimit>>>;
  /** Split of AI_FREE_DAILY_BUDGET_USD between the free features. Default DEFAULT_FREE_BUDGET_SHARES. */
  freeBudgetShares?: Partial<Record<AiFeature, number>>;
}

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Builds the ai module. Throws AiRegistryError in official mode when a model
 * in use has no known pricing, which fails boot.
 */
export function createAiModule(deps: Deps, options: AiModuleOptions): Module {
  const { config, log } = deps;
  const { registry, warnings } = buildAiRegistry(config.ai, config.mode);
  for (const warning of warnings) log.warn(warning, { module: "ai" });
  const providerKey = config.ai.provider === "groq" ? config.ai.groqApiKey : config.ai.openaiApiKey;
  if (!providerKey) {
    log.warn(
      `AI_PROVIDER is ${config.ai.provider} but its API key is not set: the AI routes return 503`,
      { module: "ai" },
    );
  }
  if (!config.ai.openaiApiKey) {
    log.warn("OPENAI_API_KEY is not set: /api/ai/createEmbedding returns 503", { module: "ai" });
  }

  const models = options.models ?? createProviderModelFactory(config.ai, deps.fetch);
  const gateway = createAiGateway(deps, {
    entitlements: options.entitlements,
    registry,
    ...(options.freeLimits ? { freeLimits: options.freeLimits } : {}),
    ...(options.freeBudgetShares ? { freeBudgetShares: options.freeBudgetShares } : {}),
  });

  let defaultClassifier: PostClassifier | null = null;
  const classifier = (): PostClassifier => {
    if (options.classifier) return options.classifier;
    if (!defaultClassifier) {
      const entry = registry.filterPosts;
      defaultClassifier = new LlmPostClassifier({
        // Throws Unavailable (503) without an API key; retried on the next request.
        model: models.languageModel(entry),
        maxOutputTokens: entry.maxOutputTokens ?? 2_000,
        providerOptions: entry.providerOptions,
        timeoutMs: totalTimeoutMs(entry),
      });
    }
    return defaultClassifier;
  };

  return {
    name: "ai",
    routes: (app) =>
      registerAiRoutes(app, {
        gateway,
        models,
        entitlements: options.entitlements,
        classifier,
      }),
    jobs: (runner) => {
      runner.every(
        "ai.prune-calls",
        PRUNE_INTERVAL_MS,
        () => {
          const deleted = pruneCalls(deps.sqlite, deps.clock.now());
          if (deleted > 0) log.info("pruned ai_calls", { deleted, olderThanDays: 90 });
        },
        { runOnStart: true, jitterMs: 60_000 },
      );
    },
  };
}
