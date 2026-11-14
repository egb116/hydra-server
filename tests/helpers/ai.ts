/** Fakes for the ai module's tests: entitlements, provider-shaped responses and an app. */
import { MockLanguageModelV4 } from "ai/test";
import type { CustomerRow } from "../../src/db/schema";
import { buildApp } from "../../src/http/app";
import { Forbidden } from "../../src/lib/errors";
import type { EntitlementService } from "../../src/modules/contracts";
import { type AiModuleOptions, createAiModule } from "../../src/modules/ai";
import type { App, Deps } from "../../src/types";
import type { FakeResponseSpec } from "./index";

export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

export const PRO_CUSTOMER = "$RCAnonymousID:0123456789abcdef";
export const FREE_CUSTOMER = "free-customer";

function customerRow(customerId: string, isPro: boolean): CustomerRow {
  return {
    id: 1,
    customerId,
    isPro,
    proExpiresAt: null,
    entitlementSource: "test",
    entitlementCheckedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** requirePro passes only for the given customer ids. */
export function fakeEntitlements(pro: readonly string[] = [PRO_CUSTOMER]): EntitlementService & {
  requirePro: (customerId: string) => CustomerRow;
  calls: string[];
} {
  const proSet = new Set(pro);
  const calls: string[] = [];
  return {
    calls,
    ensureCustomer: (id) => customerRow(id, proSet.has(id)),
    getCustomer: (id) => customerRow(id, proSet.has(id)),
    refreshIfStale: async () => {},
    isEntitled: (customer) => customer.isPro,
    requirePro: (id) => {
      calls.push(id);
      if (!proSet.has(id)) throw new Forbidden("Customer is not subscribed");
      return customerRow(id, true);
    },
  };
}

export interface ChatSpec {
  content: string | null;
  finishReason?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Omit the usage object entirely. */
  noUsage?: boolean;
}

/** A Groq (OpenAI-compatible) chat completion response. */
export function groqChat(spec: ChatSpec): FakeResponseSpec {
  return {
    json: {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_762_776_000,
      model: "openai/gpt-oss-20b",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: spec.content },
          finish_reason: spec.finishReason ?? "stop",
        },
      ],
      ...(spec.noUsage
        ? {}
        : {
            usage: {
              prompt_tokens: spec.promptTokens === undefined ? 1_000 : spec.promptTokens,
              completion_tokens: spec.completionTokens === undefined ? 200 : spec.completionTokens,
              total_tokens: 1_200,
            },
          }),
    },
  };
}

/** An OpenAI embeddings response. */
export function openaiEmbedding(vector: number[], promptTokens = 8): FakeResponseSpec {
  return {
    json: {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: vector }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    },
  };
}

/** A MockLanguageModelV4 that returns `text` once per call. */
export function mockTextModel(
  text: string,
  options: { finishReason?: "stop" | "length"; inputTokens?: number; outputTokens?: number } = {},
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doGenerate: async () => ({
      content: text === "" ? [] : [{ type: "text", text }],
      finishReason: {
        unified: options.finishReason ?? "stop",
        raw: options.finishReason ?? "stop",
      },
      usage: {
        inputTokens: {
          total: options.inputTokens ?? 100,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: options.outputTokens ?? 10, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

/** The ai module mounted on the real app, with fake entitlements by default. */
export function aiApp(
  deps: Deps,
  options: Partial<AiModuleOptions> = {},
): { app: App; entitlements: ReturnType<typeof fakeEntitlements> } {
  const entitlements = fakeEntitlements();
  const module = createAiModule(deps, { entitlements, ...options });
  return { app: buildApp(deps, [module]), entitlements };
}

/** POSTs a JSON body the way the app does: no Content-Type header. */
export function post(
  app: App,
  path: string,
  body: unknown,
  ip = "203.0.113.7",
): Response | Promise<Response> {
  return app.request(
    path,
    { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) },
    { remoteAddr: ip },
  );
}
