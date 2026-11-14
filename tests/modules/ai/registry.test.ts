import { afterEach, describe, expect, test } from "bun:test";
import {
  AiRegistryError,
  buildAiRegistry,
  costUsd,
  createAiModule,
  DEFAULT_MODELS,
} from "../../../src/modules/ai";
import { type TestDeps, testConfig, testDeps } from "../../helpers";
import {
  aiApp,
  fakeEntitlements,
  GROQ_CHAT_URL,
  groqChat,
  post,
  PRO_CUSTOMER,
} from "../../helpers/ai";

const OFFICIAL = {
  HYDRA_MODE: "official",
  REVENUECAT_PROJECT_ID: "proj",
  REVENUECAT_API_KEY: "key",
};

describe("model registry defaults", () => {
  test("groq reproduces v1: gpt-oss-20b for summaries and the filter, gpt-oss-120b for answers", () => {
    const { registry, warnings } = buildAiRegistry(testConfig().ai, "official");
    expect(warnings).toEqual([]);
    expect(registry.summarizePost.modelId).toBe("openai/gpt-oss-20b");
    expect(registry.summarizeComments.modelId).toBe("openai/gpt-oss-20b");
    expect(registry.filterPosts.modelId).toBe("openai/gpt-oss-20b");
    expect(registry.answerDocs.modelId).toBe("openai/gpt-oss-120b");
    expect(registry.embedQuery).toMatchObject({
      modelId: "text-embedding-3-small",
      provider: "openai",
      kind: "embedding",
      tier: "free",
    });
    for (const feature of [
      "summarizePost",
      "summarizeComments",
      "filterPosts",
      "answerDocs",
    ] as const) {
      expect(registry[feature].providerOptions).toEqual({ groq: { reasoningEffort: "low" } });
    }
    expect(registry.summarizePost.tier).toBe("pro");
    expect(registry.filterPosts.tier).toBe("pro");
    expect(registry.answerDocs.tier).toBe("free");
    // Groq's list price for gpt-oss-20b (v1's 0.10/0.50 was stale).
    expect(registry.summarizePost.inputUsdPerMTok).toBe(0.075);
    expect(registry.summarizePost.outputUsdPerMTok).toBe(0.3);
    expect(registry.answerDocs.inputUsdPerMTok).toBe(0.15);
    expect(registry.answerDocs.outputUsdPerMTok).toBe(0.6);
  });

  test("openai uses gpt-4.1-mini everywhere; v1's invalid 'openai/gpt-4.1-mini' filter id is fixed", () => {
    const { registry } = buildAiRegistry(testConfig({ AI_PROVIDER: "openai" }).ai, "official");
    expect(DEFAULT_MODELS.openai.filter).toBe("gpt-4.1-mini");
    expect(registry.filterPosts.modelId).toBe("gpt-4.1-mini");
    expect(registry.summarizePost.modelId).toBe("gpt-4.1-mini");
    expect(registry.filterPosts.providerOptions).toEqual({});
    expect(registry.filterPosts.inputUsdPerMTok).toBe(0.4);
    expect(registry.filterPosts.outputUsdPerMTok).toBe(1.6);
  });

  test("env overrides, including v1's OPENAI_*_MODEL aliases", () => {
    const { registry } = buildAiRegistry(
      testConfig({
        AI_PROVIDER: "openai",
        OPENAI_SUMMARY_MODEL: "gpt-4.1",
        AI_MODEL_FILTER: "openai/gpt-4.1-mini",
        AI_MODEL_ANSWER: "gpt-4.1",
      }).ai,
      "official",
    );
    expect(registry.summarizePost.modelId).toBe("gpt-4.1");
    expect(registry.filterPosts.modelId).toBe("openai/gpt-4.1-mini");
    expect(registry.answerDocs.modelId).toBe("gpt-4.1");
  });

  test("a non-gpt-oss groq filter model uses json_object mode and no reasoning effort", () => {
    const { registry } = buildAiRegistry(
      testConfig({ AI_MODEL_FILTER: "llama-3.1-8b-instant" }).ai,
      "official",
    );
    expect(registry.filterPosts.providerOptions).toEqual({
      groq: { structuredOutputs: false, strictJsonSchema: false },
    });
  });
});

describe("unknown-model pricing", () => {
  test("official mode refuses to boot", () => {
    const config = testConfig({ ...OFFICIAL, AI_MODEL_SUMMARY: "mystery-model" });
    expect(() => buildAiRegistry(config.ai, config.mode)).toThrow(AiRegistryError);
    expect(() => buildAiRegistry(config.ai, config.mode)).toThrow(/summarizePost.*mystery-model/);
  });

  describe("module", () => {
    let deps: TestDeps;
    afterEach(() => deps.cleanup());

    test("official: createAiModule throws", async () => {
      deps = await testDeps({ env: { ...OFFICIAL, AI_MODEL_FILTER: "mystery-model" } });
      expect(() => createAiModule(deps, { entitlements: fakeEntitlements() })).toThrow(
        AiRegistryError,
      );
    });

    test("selfhost: warns at boot and records the call at cost 0", async () => {
      deps = await testDeps({ env: { GROQ_API_KEY: "gsk", AI_MODEL_SUMMARY: "mystery-model" } });
      deps.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "summary" }));
      const { app } = aiApp(deps);
      const warning = deps.log.lines.find(
        (l) => l["level"] === "warn" && String(l["msg"]).includes("mystery-model"),
      );
      expect(warning).toBeDefined();

      const res = await post(app, "/api/ai/summarizePostDetails", {
        customerId: PRO_CUSTOMER,
        subreddit: "s",
        postTitle: "t",
        postAuthor: "a",
        postText: "x",
      });
      expect(res.status).toBe(200);
      const row = deps.sqlite
        .query<{ model: string; cost_usd: number; input_tokens: number }, []>(
          "SELECT model, cost_usd, input_tokens FROM ai_calls",
        )
        .get();
      expect(row).toEqual({ model: "mystery-model", cost_usd: 0, input_tokens: 1_000 });
    });
  });
});

describe("costUsd", () => {
  test("per-million pricing; unknown prices cost 0", () => {
    expect(costUsd({ inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6 }, 1_000, 500)).toBeCloseTo(
      0.0012,
      12,
    );
    expect(costUsd(null, 1_000_000, 1_000_000)).toBe(0);
    expect(costUsd({ inputUsdPerMTok: null, outputUsdPerMTok: null }, 5, 5)).toBe(0);
  });
});
