import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_FREE_LIMITS } from "../../../src/modules/ai";
import { type TestDeps, testDeps } from "../../helpers";
import {
  aiApp,
  FREE_CUSTOMER,
  GROQ_CHAT_URL,
  groqChat,
  OPENAI_EMBEDDINGS_URL,
  openaiEmbedding,
  post,
  PRO_CUSTOMER,
} from "../../helpers/ai";

const KEYS = { GROQ_API_KEY: "gsk-test", OPENAI_API_KEY: "sk-test" };

let deps: TestDeps;
afterEach(() => deps?.cleanup());

async function setup(env: Record<string, string> = {}): Promise<TestDeps> {
  deps = await testDeps({ env: { ...KEYS, ...env } });
  return deps;
}

interface CallRow {
  feature: string;
  model: string;
  customer_id: string | null;
  client_key: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  status: string;
  error: string | null;
}

function calls(d: TestDeps): CallRow[] {
  return d.sqlite.query<CallRow, []>("SELECT * FROM ai_calls ORDER BY id").all();
}

const DAY = 24 * 60 * 60 * 1000;

function insertCall(d: TestDeps, ts: number, feature: string, cost: number): void {
  d.sqlite.run(
    "INSERT INTO ai_calls (ts, feature, model, cost_usd, latency_ms, status) VALUES (?, ?, 'm', ?, 1, 'ok')",
    [ts, feature, cost],
  );
}

interface MonthlyRow {
  customer_id: string;
  month: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

function monthly(d: TestDeps): MonthlyRow[] {
  return d.sqlite.query<MonthlyRow, []>("SELECT * FROM ai_usage_monthly").all();
}

function requestJson(d: TestDeps, i = 0): Record<string, unknown> {
  const body = d.fetch.calls[i]?.body;
  if (body == null) throw new Error(`no fetch call ${i}`);
  return JSON.parse(body) as Record<string, unknown>;
}

const summaryBody = {
  customerId: PRO_CUSTOMER,
  subreddit: "typescript",
  postTitle: "Why is my build slow?",
  postAuthor: "alice",
  postText: "I have a monorepo with 40 packages and tsc takes 3 minutes.",
};

const commentsBody = {
  customerId: PRO_CUSTOMER,
  postTitle: "Why is my build slow?",
  postAuthor: "alice",
  postSummary: "Alice's monorepo builds slowly.",
  comments: ["Use project references.", "Try tsgo, it is much faster."],
};

const filterBody = {
  customerId: PRO_CUSTOMER,
  filterDescription: "posts about politics",
  posts: [
    { id: "a1", subreddit: "pics", title: "My cat", text: "" },
    { id: "b2", subreddit: "politics", title: "Election results", text: "The vote..." },
    { id: "c3", subreddit: "news", title: "Senate passes bill" },
  ],
};

describe("POST /api/ai/summarizePostDetails", () => {
  test("returns the raw summary text and calls Groq through deps.fetch", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "  A slow monorepo build.  " }));
    const { app } = aiApp(d);

    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("A slow monorepo build.");

    expect(d.fetch.calls).toHaveLength(1);
    const call = d.fetch.calls[0]!;
    expect(call.init.timeoutMs).toBeGreaterThan(0);
    expect(call.headers.get("authorization")).toBe("Bearer gsk-test");
    const sent = requestJson(d);
    expect(sent["model"]).toBe("openai/gpt-oss-20b");
    expect(sent["reasoning_effort"]).toBe("low");
    expect(sent["max_tokens"]).toBe(1_000);
    const userMessage = JSON.stringify(sent["messages"]);
    expect(userMessage).toContain("<title>");
    expect(userMessage).toContain("Why is my build slow?");
  });

  test("records the call in ai_calls and the monthly rollup", async () => {
    const d = await setup();
    d.fetch.on(
      "POST",
      GROQ_CHAT_URL,
      groqChat({ content: "ok", promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    );
    const { app } = aiApp(d);
    await post(app, "/api/ai/summarizePostDetails", summaryBody);
    await post(app, "/api/ai/summarizePostDetails", summaryBody);

    const rows = calls(d);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      feature: "summarizePost",
      model: "openai/gpt-oss-20b",
      customer_id: PRO_CUSTOMER,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      status: "ok",
    });
    // Groq's list price for gpt-oss-20b: $0.075 in, $0.30 out per million.
    expect(rows[0]!.cost_usd).toBeCloseTo(0.375, 10);
    expect(rows[0]!.client_key).toMatch(/^ip:[0-9a-f]{16}$/);
    expect(monthly(d)).toEqual([
      {
        customer_id: PRO_CUSTOMER,
        month: "2026-11",
        request_count: 2,
        input_tokens: 2_000_000,
        output_tokens: 2_000_000,
        cost_usd: expect.closeTo(0.75, 10),
      },
    ]);
  });

  test("403 text for a customer who is not Pro, with no provider call", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizePostDetails", {
      ...summaryBody,
      customerId: FREE_CUSTOMER,
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("Customer is not subscribed");
    expect(d.fetch.calls).toHaveLength(0);
    expect(calls(d)).toHaveLength(0);
  });

  test("429 text once the monthly cap is reached", async () => {
    const d = await setup({ AI_MONTHLY_LIMIT_USD: "2" });
    d.sqlite.run(
      "INSERT INTO ai_usage_monthly (customer_id, month, request_count, cost_usd) VALUES (?, '2026-11', 50, 2.0)",
      [PRO_CUSTOMER],
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Monthly usage limit exceeded");
    expect(d.fetch.calls).toHaveLength(0);
  });

  test("last month's spend does not count against the cap", async () => {
    const d = await setup({ AI_MONTHLY_LIMIT_USD: "2" });
    d.sqlite.run(
      "INSERT INTO ai_usage_monthly (customer_id, month, request_count, cost_usd) VALUES (?, '2026-10', 50, 9.0)",
      [PRO_CUSTOMER],
    );
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "fine" }));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(200);
  });

  test("selfhost default is unlimited", async () => {
    const d = await setup();
    expect(d.config.ai.monthlyLimitUsd).toBeNull();
    d.sqlite.run(
      "INSERT INTO ai_usage_monthly (customer_id, month, request_count, cost_usd) VALUES (?, '2026-11', 50, 999)",
      [PRO_CUSTOMER],
    );
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "fine" }));
    const { app } = aiApp(d);
    expect((await post(app, "/api/ai/summarizePostDetails", summaryBody)).status).toBe(200);
  });

  test("empty output is a 502 and its usage is still recorded", async () => {
    const d = await setup();
    d.fetch.on(
      "POST",
      GROQ_CHAT_URL,
      groqChat({ content: "", promptTokens: 500, completionTokens: 0 }),
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(calls(d)[0]).toMatchObject({ status: "empty", input_tokens: 500 });
    expect(monthly(d)[0]).toMatchObject({ request_count: 1, input_tokens: 500 });
  });

  test("truncated output with no text (finishReason length) is a 502", async () => {
    const d = await setup();
    d.fetch.on(
      "POST",
      GROQ_CHAT_URL,
      groqChat({
        content: null,
        finishReason: "length",
        promptTokens: 700,
        completionTokens: 1_000,
      }),
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(502);
    expect(calls(d)[0]).toMatchObject({
      status: "truncated",
      input_tokens: 700,
      output_tokens: 1_000,
    });
  });

  test("a provider error is a 502 text, recorded and alerted", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, {
      status: 401,
      json: { error: { message: "Invalid API Key", type: "invalid_request_error" } },
    });
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("The AI provider failed. Please try again later.");
    expect(calls(d)[0]).toMatchObject({
      status: "upstream_error",
      input_tokens: 0,
      output_tokens: 0,
    });
    // A rejected API key is configuration: alerted at once.
    expect(d.alerter.alerts.map((a) => a.key)).toEqual(["ai-auth:summarizePost"]);
  });

  // A transient provider error (a Groq 503) is routine: only a failure rate pages.
  test("transient provider errors alert on a failure rate, not on the first one", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, {
      status: 400,
      json: { error: { message: "bad request", type: "invalid_request_error" } },
    });
    const { app } = aiApp(d);
    for (let i = 0; i < 2; i++) {
      expect((await post(app, "/api/ai/summarizePostDetails", summaryBody)).status).toBe(502);
    }
    expect(d.alerter.alerts).toEqual([]);
    expect((await post(app, "/api/ai/summarizePostDetails", summaryBody)).status).toBe(502);
    expect(d.alerter.alerts.map((a) => a.key)).toEqual(["ai-failures:summarizePost"]);
  });

  test("missing usage normalizes to 0 tokens", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "hi", noUsage: true }));
    const { app } = aiApp(d);
    expect((await post(app, "/api/ai/summarizePostDetails", summaryBody)).status).toBe(200);
    expect(calls(d)[0]).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  });

  test("400 text for an over-long postText or a bad customerId", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const long = await post(app, "/api/ai/summarizePostDetails", {
      ...summaryBody,
      postText: "x".repeat(16_001),
    });
    expect(long.status).toBe(400);
    expect(long.headers.get("content-type")).toStartWith("text/plain");
    expect(await long.text()).toBe("Invalid request body");
    const badId = await post(app, "/api/ai/summarizePostDetails", {
      ...summaryBody,
      customerId: "a/b",
    });
    expect(badId.status).toBe(400);
    const notJson = await post(app, "/api/ai/summarizePostDetails", "{nope");
    expect(notJson.status).toBe(400);
    expect(d.fetch.calls).toHaveLength(0);
  });

  test("503 text when the provider key is missing", async () => {
    deps = await testDeps({ env: {} });
    const { app } = aiApp(deps);
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
  });
});

describe("POST /api/ai/summarizeComments", () => {
  test("returns the raw summary text with comments in numbered blocks", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "People suggest project references." }));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizeComments", commentsBody);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("People suggest project references.");
    const messages = JSON.stringify(requestJson(d)["messages"]);
    expect(messages).toContain('<comment n=\\"1\\">');
    expect(messages).toContain('<comment n=\\"2\\">');
    expect(calls(d)[0]).toMatchObject({ feature: "summarizeComments", status: "ok" });
  });

  test("an unsliced postSummary from older app builds is truncated, not rejected", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "ok" }));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizeComments", {
      ...commentsBody,
      postSummary: "y".repeat(40_000),
    });
    expect(res.status).toBe(200);
    const messages = JSON.stringify(requestJson(d)["messages"]);
    expect(messages).toContain("y".repeat(16_000));
    expect(messages).not.toContain("y".repeat(16_001));
  });

  test("403 for a customer who is not Pro", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizeComments", {
      ...commentsBody,
      customerId: FREE_CUSTOMER,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Customer is not subscribed");
  });

  test("more than 10 comments is a 400", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizeComments", {
      ...commentsBody,
      comments: Array.from({ length: 11 }, () => "c"),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ai/filterPosts", () => {
  test("maps hidden indices back to ids, covering exactly the requested ids", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: '{"hide":[1,2,7,-1]}' }));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/filterPosts", filterBody);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect(await res.json()).toEqual({ a1: false, b2: true, c3: true });

    const sent = requestJson(d);
    // Structured output: a json_schema response format.
    expect(sent["response_format"]).toMatchObject({ type: "json_schema" });
    const prompt = JSON.stringify(sent["messages"]);
    expect(prompt).toContain('<post index=\\"0\\">');
    expect(prompt).toContain('<post index=\\"2\\">');
    // Reddit ids never reach the model.
    expect(prompt).not.toContain("a1");
    expect(prompt).not.toContain("b2");
    expect(calls(d)[0]).toMatchObject({ feature: "filterPosts", status: "ok" });
  });

  test("unparseable output fails open (all false) but usage is recorded", async () => {
    const d = await setup();
    d.fetch.on(
      "POST",
      GROQ_CHAT_URL,
      groqChat({ content: "I can't help with that.", promptTokens: 2_000, completionTokens: 30 }),
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/filterPosts", filterBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a1: false, b2: false, c3: false });
    expect(calls(d)[0]).toMatchObject({
      status: "parse_error",
      input_tokens: 2_000,
      output_tokens: 30,
    });
    expect(monthly(d)[0]).toMatchObject({
      request_count: 1,
      input_tokens: 2_000,
      output_tokens: 30,
    });
  });

  test("truncated JSON is repaired with jsonrepair", async () => {
    const d = await setup();
    d.fetch.on(
      "POST",
      GROQ_CHAT_URL,
      groqChat({ content: '```json\n{"hide": [0, 2', finishReason: "length" }),
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/filterPosts", filterBody);
    expect(await res.json()).toEqual({ a1: true, b2: false, c3: true });
    expect(calls(d)[0]!.status).toBe("repaired");
  });

  test("empty output is a 502 (the app then shows every post)", async () => {
    const d = await setup();
    d.fetch.on(
      "POST",
      GROQ_CHAT_URL,
      groqChat({ content: "", finishReason: "length", completionTokens: 2_000 }),
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/filterPosts", filterBody);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(calls(d)[0]).toMatchObject({ status: "truncated", output_tokens: 2_000 });
  });

  test("duplicate ids: hidden if any of their indices is hidden", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: '{"hide":[1]}' }));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/filterPosts", {
      ...filterBody,
      posts: [
        { id: "x", subreddit: "a", title: "one" },
        { id: "x", subreddit: "a", title: "two" },
        { id: "__proto__", subreddit: "a", title: "three" },
      ],
    });
    const body = (await res.json()) as Record<string, boolean>;
    expect(Object.keys(body).sort()).toEqual(["__proto__", "x"]);
    expect(body["x"]).toBe(true);
    expect(body["__proto__"]).toBe(false);
  });

  test("no posts or a blank description: all false, no provider call, still gated", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const blank = await post(app, "/api/ai/filterPosts", {
      ...filterBody,
      filterDescription: "  ",
    });
    expect(await blank.json()).toEqual({ a1: false, b2: false, c3: false });
    const none = await post(app, "/api/ai/filterPosts", { ...filterBody, posts: [] });
    expect(await none.json()).toEqual({});
    const notPro = await post(app, "/api/ai/filterPosts", {
      ...filterBody,
      posts: [],
      customerId: FREE_CUSTOMER,
    });
    expect(notPro.status).toBe(403);
    expect(d.fetch.calls).toHaveLength(0);
  });

  test("errors are text, so the app's response.json() throws instead of misreading them", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/filterPosts", {
      ...filterBody,
      customerId: FREE_CUSTOMER,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Customer is not subscribed");
    const bad = await post(app, "/api/ai/filterPosts", { ...filterBody, posts: "nope" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toStartWith("text/plain");
  });

  test("an injected classifier replaces the LLM", async () => {
    const d = await setup();
    const { app } = aiApp(d, {
      classifier: {
        name: "keyword",
        classify: async ({ posts }) => ({
          hide: new Set(posts.filter((p) => p.subreddit === "politics").map((p) => p.index)),
        }),
      },
    });
    const res = await post(app, "/api/ai/filterPosts", filterBody);
    expect(await res.json()).toEqual({ a1: false, b2: true, c3: false });
    expect(d.fetch.calls).toHaveLength(0);
    expect(calls(d)[0]).toMatchObject({ feature: "filterPosts", status: "ok", input_tokens: 0 });
  });
});

describe("POST /api/ai/askQuestion", () => {
  const askBody = { question: "How do I add an account?", docs: ["# Accounts\nTap the + button."] };

  test("returns {markdown}", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "Tap the **+** button." }));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/askQuestion", askBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markdown: "Tap the **+** button." });
    const sent = requestJson(d);
    expect(sent["model"]).toBe("openai/gpt-oss-120b");
    expect(sent["max_tokens"]).toBe(1_500);
    expect(calls(d)[0]).toMatchObject({ feature: "answerDocs", customer_id: null, status: "ok" });
    expect(monthly(d)).toHaveLength(0);
  });

  test("an empty answer (the prompt asks for one on vague questions) is {markdown: ''}", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "" }));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/askQuestion", askBody);
    expect(await res.json()).toEqual({ markdown: "" });
    expect(calls(d)[0]!.status).toBe("empty");
  });

  test("per-IP limiter: 429 'Throttled' with Retry-After, other IPs unaffected, refills", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer" }));
    const { app } = aiApp(d, {
      freeLimits: { answerDocs: { capacity: 2, refillPerSecond: 1 / 60 } },
    });
    expect((await post(app, "/api/ai/askQuestion", askBody, "198.51.100.1")).status).toBe(200);
    expect((await post(app, "/api/ai/askQuestion", askBody, "198.51.100.1")).status).toBe(200);
    const limited = await post(app, "/api/ai/askQuestion", askBody, "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("Throttled");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(app, "/api/ai/askQuestion", askBody, "198.51.100.2")).status).toBe(200);
    d.clock.advance(60_000);
    expect((await post(app, "/api/ai/askQuestion", askBody, "198.51.100.1")).status).toBe(200);
    expect(d.metrics.get("ai.throttled.answerDocs")).toBe(1);
  });

  test("the daily free budget: answerDocs gets 90%, 429 and an alert once its own spend reaches it", async () => {
    const d = await setup({ AI_FREE_DAILY_BUDGET_USD: "1" });
    const now = d.clock.now();
    // Yesterday's spend, Pro spend and embedQuery spend don't count.
    insertCall(d, now - 24 * 60 * 60 * 1000, "answerDocs", 5);
    insertCall(d, now, "summarizePost", 5);
    insertCall(d, now, "embedQuery", 5);
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer", noUsage: true }));
    const { app } = aiApp(d);
    insertCall(d, now, "answerDocs", 0.89);
    expect((await post(app, "/api/ai/askQuestion", askBody)).status).toBe(200);

    insertCall(d, now, "answerDocs", 0.01);
    const res = await post(app, "/api/ai/askQuestion", askBody);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Throttled");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(d.alerter.alerts.map((a) => a.key)).toContain("ai-free-budget:answerDocs");
    expect(d.fetch.calls).toHaveLength(1);
  });

  test("regression: answerDocs spend does not lock out createEmbedding", async () => {
    const d = await setup({ AI_FREE_DAILY_BUDGET_USD: "5" });
    const now = d.clock.now();
    insertCall(d, now, "answerDocs", 5);
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer" }));
    d.fetch.on("POST", OPENAI_EMBEDDINGS_URL, openaiEmbedding([1], 10));
    const { app } = aiApp(d);
    expect((await post(app, "/api/ai/askQuestion", askBody)).status).toBe(429);
    const embed = await post(app, "/api/ai/createEmbedding", { text: "x" }, "198.51.100.9");
    expect(embed.status).toBe(200);

    // embedQuery has its own 10% share.
    insertCall(d, now, "embedQuery", 0.5);
    expect((await post(app, "/api/ai/createEmbedding", { text: "x" })).status).toBe(429);
    expect(d.alerter.alerts.map((a) => a.key)).toContain("ai-free-budget:embedQuery");
  });

  test("freeBudgetShares overrides the split", async () => {
    const d = await setup({ AI_FREE_DAILY_BUDGET_USD: "1" });
    insertCall(d, d.clock.now(), "answerDocs", 0.95);
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer" }));
    const { app } = aiApp(d, { freeBudgetShares: { answerDocs: 1 } });
    expect((await post(app, "/api/ai/askQuestion", askBody)).status).toBe(200);
  });

  test("AI_FREE_DAILY_BUDGET_USD=0 still disables both free features", async () => {
    const d = await setup({ AI_FREE_DAILY_BUDGET_USD: "0" });
    const { app } = aiApp(d);
    expect((await post(app, "/api/ai/askQuestion", askBody)).status).toBe(429);
    expect((await post(app, "/api/ai/createEmbedding", { text: "x" })).status).toBe(429);
    expect(d.fetch.calls).toHaveLength(0);
  });

  test("regression: rotating IPv6 addresses inside one /64 shares one bucket", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer" }));
    const { app } = aiApp(d, {
      freeLimits: { answerDocs: { capacity: 3, refillPerSecond: 1 / 30 } },
    });
    const statuses: number[] = [];
    for (let i = 1; i <= 20; i++) {
      const ip = `2001:db8:1:2::${i.toString(16)}`;
      statuses.push((await post(app, "/api/ai/askQuestion", askBody, ip)).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(17);
    // A different /64 has its own bucket.
    expect((await post(app, "/api/ai/askQuestion", askBody, "2001:db8:1:3::1")).status).toBe(200);
    // ai_calls.client_key is the network's hash, the same for every address in the /64.
    const keys = new Set(
      calls(d)
        .slice(0, 3)
        .map((r) => r.client_key),
    );
    expect(keys.size).toBe(1);
  });

  test("regression: IPv4-mapped IPv6 shares the IPv4 address's bucket", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer" }));
    const { app } = aiApp(d, {
      freeLimits: { answerDocs: { capacity: 1, refillPerSecond: 1 / 60 } },
    });
    expect((await post(app, "/api/ai/askQuestion", askBody, "198.51.100.4")).status).toBe(200);
    expect((await post(app, "/api/ai/askQuestion", askBody, "::ffff:198.51.100.4")).status).toBe(
      429,
    );
  });

  test("regression: a per-client daily cap stops one client draining the free budget", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer" }));
    const { app } = aiApp(d, {
      // A fast refill, so only the daily cap can stop it.
      freeLimits: { answerDocs: { capacity: 100, refillPerSecond: 100, dailyPerClient: 4 } },
    });
    for (let i = 0; i < 4; i++) {
      // Rotating within one /64 doesn't escape the cap either.
      const ip = `2001:db8:5:6::${i + 1}`;
      expect((await post(app, "/api/ai/askQuestion", askBody, ip)).status).toBe(200);
    }
    const capped = await post(app, "/api/ai/askQuestion", askBody, "2001:db8:5:6::99");
    expect(capped.status).toBe(429);
    expect(await capped.text()).toBe("Throttled");
    // Retry-After points at midnight UTC.
    const now = d.clock.now();
    const untilMidnight = Math.ceil((DAY - (now % DAY)) / 1000);
    expect(Number(capped.headers.get("retry-after"))).toBe(untilMidnight);
    expect(d.metrics.get("ai.daily_client_cap.answerDocs")).toBe(1);
    // Another client is unaffected; the cap resets at midnight UTC.
    expect((await post(app, "/api/ai/askQuestion", askBody, "198.51.100.20")).status).toBe(200);
    d.clock.advance(DAY - (now % DAY));
    expect((await post(app, "/api/ai/askQuestion", askBody, "2001:db8:5:6::99")).status).toBe(200);
  });

  test("the default daily caps are 50 askQuestion and 200 createEmbedding per client", () => {
    expect(DEFAULT_FREE_LIMITS.answerDocs?.dailyPerClient).toBe(50);
    expect(DEFAULT_FREE_LIMITS.embedQuery?.dailyPerClient).toBe(200);
  });

  test("regression: only the first 3 docs, each cut to 10k characters, reach the model", async () => {
    const d = await setup();
    d.fetch.on("POST", GROQ_CHAT_URL, groqChat({ content: "answer" }));
    const { app } = aiApp(d);
    const docs = ["A".repeat(19_000), "doc-two", "doc-three", "doc-four-MARK", "doc-five-MARK"];
    const res = await post(app, "/api/ai/askQuestion", { question: "q", docs });
    expect(res.status).toBe(200);
    const sent = JSON.stringify(requestJson(d)["messages"]);
    expect(sent).toContain("doc-three");
    expect(sent).not.toContain("MARK");
    expect(sent).toContain("A".repeat(10_000));
    expect(sent).not.toContain("A".repeat(10_001));
  });

  test("docs are bounded by count and size", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const many = await post(app, "/api/ai/askQuestion", {
      question: "q",
      docs: Array(6).fill("d"),
    });
    expect(many.status).toBe(400);
    const big = await post(app, "/api/ai/askQuestion", {
      question: "q",
      docs: ["d".repeat(20_001)],
    });
    expect(big.status).toBe(400);
  });
});

describe("POST /api/ai/createEmbedding", () => {
  test("returns the vector as a JSON array via text-embedding-3-small", async () => {
    const d = await setup();
    d.fetch.on("POST", OPENAI_EMBEDDINGS_URL, openaiEmbedding([0.1, -0.2, 0.3], 1_000_000));
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/createEmbedding", { text: "how do filters work" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([0.1, -0.2, 0.3]);
    const sent = requestJson(d);
    expect(sent["model"]).toBe("text-embedding-3-small");
    expect(sent["input"]).toEqual(["how do filters work"]);
    expect(d.fetch.calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(calls(d)[0]).toMatchObject({
      feature: "embedQuery",
      input_tokens: 1_000_000,
      status: "ok",
    });
    expect(calls(d)[0]!.cost_usd).toBeCloseTo(0.02, 10);
  });

  test("ignores OPENAI_BASE_URL like v1 (embeddings always go to api.openai.com)", async () => {
    const d = await setup({ AI_PROVIDER: "openai", OPENAI_BASE_URL: "https://llm.example.com/v1" });
    d.fetch.on("POST", OPENAI_EMBEDDINGS_URL, openaiEmbedding([1]));
    const { app } = aiApp(d);
    expect((await post(app, "/api/ai/createEmbedding", { text: "x" })).status).toBe(200);
  });

  test("503 text when OPENAI_API_KEY is missing", async () => {
    deps = await testDeps({ env: { GROQ_API_KEY: "gsk-test" } });
    const { app } = aiApp(deps);
    const res = await post(app, "/api/ai/createEmbedding", { text: "x" });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("Embeddings are not configured on this server");
  });

  test("input is capped at 2,000 characters", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    expect((await post(app, "/api/ai/createEmbedding", { text: "x".repeat(2_001) })).status).toBe(
      400,
    );
    expect((await post(app, "/api/ai/createEmbedding", { text: "" })).status).toBe(400);
  });

  test("per-IP limiter applies", async () => {
    const d = await setup();
    d.fetch.on("POST", OPENAI_EMBEDDINGS_URL, openaiEmbedding([1]));
    const { app } = aiApp(d, {
      freeLimits: { embedQuery: { capacity: 1, refillPerSecond: 0.001 } },
    });
    expect((await post(app, "/api/ai/createEmbedding", { text: "x" })).status).toBe(200);
    const res = await post(app, "/api/ai/createEmbedding", { text: "x" });
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Throttled");
  });
});

describe("errors are text on every status", () => {
  // Old app builds render the summarize body as the summary (see routes.ts),
  // so even an unexpected 500 must not be a JSON envelope.
  test("an unexpected throw is a logged text 500", async () => {
    const d = await setup();
    const { app } = aiApp(d, {
      models: {
        languageModel: () => {
          throw new TypeError("boom");
        },
        embeddingModel: () => {
          throw new TypeError("boom");
        },
      },
    });
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("Internal error");
  });
});

describe("OPTIONS preflight still works for AI routes", () => {
  test("200 with the legacy CORS headers", async () => {
    const d = await setup();
    const { app } = aiApp(d);
    const res = await app.request("/api/ai/filterPosts", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("AI_PROVIDER=openai", () => {
  test("filterPosts sends the fixed 'gpt-4.1-mini' id to OPENAI_BASE_URL and prices it", async () => {
    const d = await setup({ AI_PROVIDER: "openai", OPENAI_BASE_URL: "https://llm.example.com/v1" });
    // Chat Completions, which every OpenAI-compatible server implements.
    d.fetch.on(
      "POST",
      "https://llm.example.com/v1/chat/completions",
      groqChat({ content: '{"hide":[0]}', promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/filterPosts", filterBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a1: true, b2: false, c3: false });
    expect(requestJson(d)["model"]).toBe("gpt-4.1-mini");
    expect(d.fetch.calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    const row = calls(d)[0]!;
    expect(row.model).toBe("gpt-4.1-mini");
    expect(row.cost_usd).toBeCloseTo(2.0, 10);
  });

  test("summaries come back as raw text", async () => {
    const d = await setup({ AI_PROVIDER: "openai" });
    d.fetch.on(
      "POST",
      "https://api.openai.com/v1/chat/completions",
      groqChat({ content: "A summary." }),
    );
    const { app } = aiApp(d);
    const res = await post(app, "/api/ai/summarizePostDetails", summaryBody);
    expect(await res.text()).toBe("A summary.");
  });
});
