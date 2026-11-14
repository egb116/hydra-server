/**
 * Harness for the legacy HTTP contract tests (tests/contract/**).
 *
 * The contract tests are an independent oracle: they build the real app from
 * src/modules/index.ts and talk to it only over HTTP, the way the installed
 * Hydra app does, with every upstream (RevenueCat, Groq/OpenAI) faked through
 * deps.fetch. Expectations are derived from the app's code (APP = the Hydra
 * repo) and v1's server code, never from the new module
 * implementations.
 */
import type { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import type { Env } from "../../src/config";
import { buildApp } from "../../src/http/app";
import { createModules } from "../../src/modules/index";
import type { App } from "../../src/types";
import { type FakeFetch, type FetchCall, type TestDeps, fakeFetch, testDeps } from "./index";

// ------------------------------------------------------------------- the app

export interface ContractApp {
  app: App;
  deps: TestDeps;
  fetch: FakeFetch;
  /** A raw request against the app. `path` starts with "/". */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /**
   * POST exactly as the app does (APP:api/*.ts): `fetch(url, { method: "POST",
   * body: JSON.stringify(body) })`, with no headers at all.
   */
  post: (path: string, body: unknown) => Promise<Response>;
  cleanup: () => void;
}

export interface ContractAppOptions {
  env?: Env;
  fetch?: FakeFetch;
}

export async function contractApp(opts: ContractAppOptions = {}): Promise<ContractApp> {
  const fetch = opts.fetch ?? fakeFetch();
  const deps = await testDeps({ env: opts.env, fetch });
  const app = buildApp(deps, createModules(deps));
  const request = async (path: string, init?: RequestInit): Promise<Response> =>
    await app.request(path, init);
  return {
    app,
    deps,
    fetch,
    request,
    post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body) }),
    cleanup: () => deps.cleanup(),
  };
}

/**
 * Returns a factory for contract apps that are cleaned up after each test.
 * Call it once at the top level of a test file.
 */
export function useContractApps(): (opts?: ContractAppOptions) => Promise<ContractApp> {
  const live: ContractApp[] = [];
  afterEach(() => {
    for (const ctx of live.splice(0)) ctx.cleanup();
  });
  return async (opts) => {
    const ctx = await contractApp(opts);
    live.push(ctx);
    return ctx;
  };
}

// ---------------------------------------------------------------- env presets

export const RC_PROJECT_ID = "proj_contract01";
export const RC_API_KEY = "sk_contract_revenuecat";
export const GROQ_API_KEY = "gsk_contract_groq";
export const OPENAI_API_KEY = "sk-contract-openai";

/** Both AI keys, so every AI feature is configured. */
export const AI_ENV: Env = { GROQ_API_KEY, OPENAI_API_KEY };

/** The official server (api.hydraapp.io): RevenueCat gates Pro features. */
export const OFFICIAL_ENV: Env = {
  HYDRA_MODE: "official",
  REVENUECAT_PROJECT_ID: RC_PROJECT_ID,
  REVENUECAT_API_KEY: RC_API_KEY,
  ...AI_ENV,
};

/** A self-hosted server (v1's IS_CUSTOM_SERVER=true): everyone is Pro. */
export const SELFHOST_ENV: Env = { HYDRA_MODE: "selfhost", ...AI_ENV };

// ---------------------------------------------------------------- RevenueCat

/** v1 services/RevenueCat.ts:17 */
export const HYDRA_PRO_ENTITLEMENT_ID = "entla7f4253fb6";

export type RcCustomerState =
  /** Has the Hydra Pro entitlement. expiresAt null is a lifetime purchase. */
  | { kind: "entitled"; expiresAt: number | null }
  /** Exists in RevenueCat but without Hydra Pro (another entitlement only). */
  | { kind: "not_entitled" }
  /** RevenueCat answers 404. */
  | { kind: "missing" }
  /** RevenueCat answers this status with a non-JSON body. */
  | { kind: "error"; status: number }
  /** The connection fails. */
  | { kind: "network_error" };

export interface FakeRevenueCat {
  set(customerId: string, state: RcCustomerState): void;
  /** Every request that went to api.revenuecat.com (matched or not). */
  calls(): FetchCall[];
}

const RC_HOST = "https://api.revenuecat.com";
const RC_CUSTOMER_URL =
  /^https:\/\/api\.revenuecat\.com\/v2\/projects\/([^/?#]+)\/customers\/([^/?#]+)(?:\?.*)?$/;

/** The RevenueCat URL v2 must call for a customer. */
export function rcCustomerUrl(customerId: string, projectId = RC_PROJECT_ID): string {
  return `${RC_HOST}/v2/projects/${encodeURIComponent(projectId)}/customers/${encodeURIComponent(customerId)}`;
}

function rcCustomerBody(projectId: string, id: string, items: unknown[]): unknown {
  const base = `/v2/projects/${projectId}/customers/${encodeURIComponent(id)}`;
  // Shape of RevenueCat's v2 "customer" object (v1 services/RevenueCat.ts:1-15
  // reads active_entitlements.items[].entitlement_id), with the other fields a
  // real response carries so a strict parser would be caught out here.
  return {
    object: "customer",
    id,
    project_id: projectId,
    first_seen_at: 1_750_000_000_000,
    last_seen_at: 1_760_000_000_000,
    last_seen_app_version: "2.9.0",
    last_seen_country: "US",
    last_seen_platform: "iOS",
    last_seen_platform_version: "18.1",
    active_entitlements: {
      object: "list",
      items,
      next_page: null,
      url: `${base}/active_entitlements`,
    },
    attributes: { object: "list", items: [], next_page: null, url: `${base}/attributes` },
  };
}

/**
 * Fakes RevenueCat's `GET /v2/projects/{pid}/customers/{id}`. Unknown customers
 * get a 404. Every other RevenueCat URL is left unrouted, so fakeFetch throws.
 */
export function fakeRevenueCat(
  fetch: FakeFetch,
  initial: Record<string, RcCustomerState> = {},
): FakeRevenueCat {
  const states = new Map<string, RcCustomerState>(Object.entries(initial));
  fetch.on("GET", RC_CUSTOMER_URL, (call) => {
    const match = RC_CUSTOMER_URL.exec(call.url);
    const projectId = decodeURIComponent(match?.[1] ?? "");
    const id = decodeURIComponent(match?.[2] ?? "");
    const state: RcCustomerState = states.get(id) ?? { kind: "missing" };
    switch (state.kind) {
      case "entitled":
        return {
          json: rcCustomerBody(projectId, id, [
            {
              object: "customer.active_entitlement",
              entitlement_id: HYDRA_PRO_ENTITLEMENT_ID,
              expires_at: state.expiresAt,
            },
          ]),
        };
      case "not_entitled":
        return {
          json: rcCustomerBody(projectId, id, [
            {
              object: "customer.active_entitlement",
              entitlement_id: "entl0ther7ip5",
              expires_at: null,
            },
          ]),
        };
      case "missing":
        return {
          status: 404,
          json: {
            object: "error",
            type: "resource_missing",
            param: "customer_id",
            doc_url: "https://errors.rev.cat/resource-missing",
            message: "Customer not found",
            retryable: false,
          },
        };
      case "error":
        return {
          status: state.status,
          body: "upstream exploded",
          headers: { "content-type": "text/plain" },
        };
      case "network_error":
        break;
    }
    throw new TypeError("fetch failed: ECONNRESET");
  });
  return {
    set: (customerId, state) => states.set(customerId, state),
    calls: () => fetch.calls.filter((c) => c.url.startsWith(RC_HOST)),
  };
}

// ------------------------------------------------------------- AI providers

export interface AiRequest {
  url: string;
  /** The parsed JSON request body sent to the provider. */
  body: Record<string, unknown>;
}

export interface FakeAiOptions {
  /** The assistant text for chat-completions / responses calls. */
  reply?: string | ((req: AiRequest) => string);
  /** Token usage reported for chat calls (default 100 in / 50 out). */
  usage?: { inputTokens: number; outputTokens: number };
  /** The vector for every embeddings input (default: a 1536-dim vector). */
  embedding?: number[];
  /** Token usage reported for embedding calls (default 8). */
  embeddingTokens?: number;
}

export interface FakeAi {
  /** Calls to any `.../chat/completions` or `.../responses` endpoint. */
  chatCalls(): FetchCall[];
  /** Calls to any `.../embeddings` endpoint. */
  embeddingCalls(): FetchCall[];
}

/**
 * text-embedding-3-small has 1536 dimensions; the app's bundled doc vectors
 * have the same length (APP:constants/documentation.ts). Values are exact in
 * float32 so a Float32Array round trip on the server can't change them.
 */
export const DEFAULT_EMBEDDING: number[] = Array.from(
  { length: 1536 },
  (_, i) => ((i % 64) - 32) / 1024,
);

const CHAT_URL = /\/chat\/completions(?:\?.*)?$/;
const RESPONSES_URL = /\/responses(?:\?.*)?$/;
const EMBEDDINGS_URL = /\/embeddings(?:\?.*)?$/;

function modelOf(body: Record<string, unknown>): string {
  return typeof body.model === "string" ? body.model : "unknown-model";
}

function parseBody(call: FetchCall): Record<string, unknown> {
  if (call.body === null) return {};
  return JSON.parse(call.body) as Record<string, unknown>;
}

/**
 * Fakes the OpenAI-compatible endpoints that @ai-sdk/groq and @ai-sdk/openai
 * call, on any host (api.groq.com/openai/v1, api.openai.com/v1, or a custom
 * OPENAI_BASE_URL):
 * - POST {base}/chat/completions (groq; openai `.chat()`), node_modules/@ai-sdk/groq/dist/index.js:590
 * - POST {base}/responses (openai default language model), node_modules/@ai-sdk/openai/dist/index.js:7430
 * - POST {base}/embeddings, node_modules/@ai-sdk/openai/dist/index.js:2623
 * Response bodies follow the providers' zod schemas (groqChatResponseSchema,
 * openaiResponsesResponseSchema, openaiTextEmbeddingResponseSchema). Streaming
 * is not faked: every legacy route returns a whole body.
 */
export function fakeAI(fetch: FakeFetch, opts: FakeAiOptions = {}): FakeAi {
  const usage = opts.usage ?? { inputTokens: 100, outputTokens: 50 };
  const replyFor = (call: FetchCall, body: Record<string, unknown>): string => {
    const reply = opts.reply ?? "A fake model reply.";
    return typeof reply === "function" ? reply({ url: call.url, body }) : reply;
  };

  fetch.on("POST", CHAT_URL, (call) => {
    const body = parseBody(call);
    if (body.stream === true) throw new Error("fakeAI: streaming chat completions are not faked");
    return {
      json: {
        id: "chatcmpl-contract",
        object: "chat.completion",
        created: 1_762_776_000,
        model: modelOf(body),
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: replyFor(call, body) },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
      },
    };
  });

  fetch.on("POST", RESPONSES_URL, (call) => {
    const body = parseBody(call);
    if (body.stream === true) throw new Error("fakeAI: streaming responses are not faked");
    return {
      json: {
        id: "resp_contract",
        object: "response",
        created_at: 1_762_776_000,
        status: "completed",
        model: modelOf(body),
        output: [
          {
            type: "message",
            id: "msg_contract",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: replyFor(call, body), annotations: [] }],
          },
        ],
        incomplete_details: null,
        usage: {
          input_tokens: usage.inputTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: usage.outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
      },
    };
  });

  fetch.on("POST", EMBEDDINGS_URL, (call) => {
    const body = parseBody(call);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const tokens = opts.embeddingTokens ?? 8;
    return {
      json: {
        object: "list",
        data: inputs.map((_, index) => ({
          object: "embedding",
          index,
          embedding: opts.embedding ?? DEFAULT_EMBEDDING,
        })),
        model: modelOf(body),
        usage: { prompt_tokens: tokens, total_tokens: tokens },
      },
    };
  });

  return {
    chatCalls: () => fetch.calls.filter((c) => CHAT_URL.test(c.url) || RESPONSES_URL.test(c.url)),
    embeddingCalls: () => fetch.calls.filter((c) => EMBEDDINGS_URL.test(c.url)),
  };
}

/** The parsed JSON body of a recorded outbound call. */
export function callBody(call: FetchCall): Record<string, unknown> {
  return parseBody(call);
}

// ------------------------------------------------------------- app fixtures

/** A RevenueCat anonymous app user id, as `customerInfo.originalAppUserId` holds (APP:contexts/SubscriptionsContext.tsx:87). */
export function anonCustomerId(n: number): string {
  return `$RCAnonymousID:${n.toString(16).padStart(32, "0")}`;
}

/** An Expo push token, as `Notifications.getExpoPushTokenAsync()` returns (APP:contexts/SettingsContexts/NotificationsContext.tsx:48). */
export function expoPushToken(n: number): string {
  return `ExponentPushToken[contract${n.toString().padStart(14, "0")}]`;
}

/**
 * The session string the app stores and sends: JSON of the reddit_session
 * cookie object (APP:utils/RedditCookies.ts:28-35).
 */
export function sessionFor(username: string, version = 1): string {
  return JSON.stringify({
    name: "reddit_session",
    value: `eyJhbGciOiJSUzI1NiJ9.${username}-v${version}.c2lnbmF0dXJl`,
    domain: ".reddit.com",
    path: "/",
    secure: true,
    httpOnly: true,
    expires: "2027-05-10T12:00:00.000Z",
  });
}

// ------------------------------------------------------------- DB inspection

/**
 * Usernames linked to a device (devices, device_accounts, reddit_accounts). Multi-device registration has no other
 * HTTP-observable effect until the poller pushes.
 */
export function deviceUsernames(sqlite: Database, pushToken: string): string[] {
  return sqlite
    .query<{ username: string }, [string]>(
      `SELECT ra.username AS username
         FROM devices d
         JOIN device_accounts da ON da.device_id = d.id
         JOIN reddit_accounts ra ON ra.id = da.account_id
        WHERE d.push_token = ?
        ORDER BY ra.username`,
    )
    .all(pushToken)
    .map((r) => r.username);
}

export interface AccountRow {
  customerId: string;
  username: string;
  sessionEnc: string;
}

export function accountRows(sqlite: Database): AccountRow[] {
  return sqlite
    .query<AccountRow, []>(
      `SELECT c.customer_id AS customerId, ra.username AS username, ra.session_enc AS sessionEnc
         FROM reddit_accounts ra
         JOIN customers c ON c.id = ra.customer_id
        ORDER BY c.customer_id, ra.username`,
    )
    .all();
}

export function deviceCount(sqlite: Database): number {
  return sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM devices").get()?.n ?? 0;
}
