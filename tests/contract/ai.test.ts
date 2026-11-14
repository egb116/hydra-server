/**
 * Legacy contract: the five /api/ai/* routes.
 * APP = C:/…/Hydra (the mobile app), v1 = the v1 server files in this repo.
 * Providers are faked by fakeAI (tests/helpers/contractApp.ts), which answers
 * the OpenAI-compatible chat-completions, responses and embeddings endpoints.
 */
import { describe, expect, test } from "bun:test";
import type { Env } from "../../src/config";
import {
  DEFAULT_EMBEDDING,
  OFFICIAL_ENV,
  SELFHOST_ENV,
  anonCustomerId,
  callBody,
  fakeAI,
  fakeRevenueCat,
  useContractApps,
  type ContractApp,
  type FakeAiOptions,
} from "../helpers/contractApp";

const makeApp = useContractApps();

// ------------------------------------------------------------------ fixtures

/** Reddit's own limits: title ≤ 300 chars, subreddit ≤ 21, username ≤ 20, self text ≤ 40,000. */
const REDDIT_MAX_TITLE = 300;
const REDDIT_MAX_SELFTEXT = 40_000;

/** APP:api/AI.ts:12-24 */
function summarizePostBody(customerId: string, postText = "Long text. ".repeat(100)) {
  return {
    customerId,
    subreddit: "hydraapp",
    postTitle: "What do you think of the new release?",
    postAuthor: "someone",
    postText,
  };
}

/** APP:api/AI.ts:36-48 */
function summarizeCommentsBody(
  customerId: string,
  postSummary = "The post asks about the release.",
  comments?: string[],
) {
  return {
    customerId,
    postTitle: "What do you think of the new release?",
    postAuthor: "someone",
    postSummary,
    comments: comments ?? ["I like it.", "It crashes on launch for me.", "Works fine on Android."],
  };
}

interface AppPost {
  id: string;
  subreddit: string;
  title: string;
  text: string;
}

/** Posts as APP:api/AI.ts:66-71 sends them (text sliced to 500). */
function makePosts(n: number): AppPost[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `1p${i.toString(36).padStart(4, "0")}`,
    subreddit: i % 2 === 0 ? "pics" : "AskReddit",
    title: `Post number ${i}`,
    text: i % 3 === 0 ? "" : `Body of post ${i}`,
  }));
}

/** APP:api/AI.ts:61-73 */
function filterBody(
  customerId: string,
  posts: AppPost[],
  filterDescription = "posts about politics",
) {
  return { customerId, filterDescription, posts };
}

/**
 * The posts the app shows after the AI filter: APP:api/AI.ts:74 does
 * `response.json()` with no status check, and
 * APP:contexts/SettingsContexts/FiltersContext.tsx:105-111 hides a post when
 * `aiFilter[post.id]` is truthy, keeping everything if anything throws.
 */
async function appVisiblePosts(res: Response, posts: AppPost[]): Promise<string[]> {
  try {
    const aiFilter = (await res.json()) as Record<string, unknown>;
    return posts.filter((post) => !aiFilter[post.id]).map((p) => p.id);
  } catch {
    return posts.map((p) => p.id);
  }
}

/** The JSON a {hide: number[]} classifier answers (contracts.ts PostClassifier). */
const hideReply = (indices: number[]): string => JSON.stringify({ hide: indices });

const SUMMARY_TEXT = "The author asks for feedback on the release; most replies are positive.";

async function selfhost(ai: FakeAiOptions = {}, env: Env = {}) {
  const ctx = await makeApp({ env: { ...SELFHOST_ENV, ...env } });
  return { ctx, ai: fakeAI(ctx.fetch, { reply: SUMMARY_TEXT, ...ai }) };
}

/** An official server with one entitled, registered customer. */
async function officialWithPro(customerId: string, ai: FakeAiOptions = {}, env: Env = {}) {
  const ctx = await makeApp({ env: { ...OFFICIAL_ENV, ...env } });
  const rc = fakeRevenueCat(ctx.fetch, { [customerId]: { kind: "entitled", expiresAt: null } });
  const fake = fakeAI(ctx.fetch, { reply: SUMMARY_TEXT, ...ai });
  const reg = await ctx.post("/api/customers/register", { customerId });
  expect(reg.status).toBe(200);
  return { ctx, ai: fake, rc };
}

/** Drives requests until one is not 200; returns the count and that status. */
async function untilNot200(ctx: ContractApp, path: string, body: unknown, max: number) {
  for (let i = 1; i <= max; i++) {
    const res = await ctx.post(path, body);
    if (res.status !== 200) return { n: i, status: res.status };
    await res.arrayBuffer();
  }
  return { n: max, status: 200 };
}

/** A usage big enough to exceed any tiny limit at any registry price. */
const HUGE_USAGE = { inputTokens: 2_000_000, outputTokens: 2_000_000 };

// ---------------------------------------------------- summarizePostDetails

describe("POST /api/ai/summarizePostDetails", () => {
  // v1 routes/ai/summarizePostDetails.ts:63-65 returns the model's raw text;
  // the app reads it with `response.text()` (APP:api/AI.ts:28) and shows it as is.
  test("200 with the raw summary text (not JSON-encoded)", async () => {
    const { ctx, ai } = await selfhost();
    const res = await ctx.post(
      "/api/ai/summarizePostDetails",
      summarizePostBody(anonCustomerId(1), "MARKER-POST-TEXT ".repeat(60)),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SUMMARY_TEXT);
    expect(ai.chatCalls()).toHaveLength(1);
    expect(ai.chatCalls()[0]!.body ?? "").toContain("MARKER-POST-TEXT");
  });

  // v1 utils/models.ts:218-223: AI_PROVIDER defaults to groq.
  test("the default provider is Groq", async () => {
    const { ctx, ai } = await selfhost();
    const res = await ctx.post(
      "/api/ai/summarizePostDetails",
      summarizePostBody(anonCustomerId(2)),
    );
    expect(res.status).toBe(200);
    expect(ai.chatCalls()[0]!.url).toStartWith("https://api.groq.com/openai/v1/");
  });

  // v1 utils/models.ts:216-228: AI_PROVIDER=openai uses OPENAI_BASE_URL, so
  // self-hosters can point it at any OpenAI-compatible server.
  test("AI_PROVIDER=openai with OPENAI_BASE_URL: same 200 shape, calls the custom base", async () => {
    const { ctx, ai } = await selfhost(
      {},
      { AI_PROVIDER: "openai", OPENAI_BASE_URL: "https://llm.selfhost.test/v1" },
    );
    const res = await ctx.post(
      "/api/ai/summarizePostDetails",
      summarizePostBody(anonCustomerId(3)),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SUMMARY_TEXT);
    expect(ai.chatCalls()[0]!.url).toStartWith("https://llm.selfhost.test/v1/");
  });

  // APP:api/AI.ts:17-21 bounds postText at 15,000; titles are up to 300.
  test("the largest request the app can send is accepted", async () => {
    const { ctx } = await selfhost();
    const body = {
      ...summarizePostBody(anonCustomerId(4), "w".repeat(15_000)),
      subreddit: "s".repeat(21),
      postTitle: "t".repeat(REDDIT_MAX_TITLE),
      postAuthor: "a".repeat(20),
    };
    const res = await ctx.post("/api/ai/summarizePostDetails", body);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SUMMARY_TEXT);
  });

  // v1 middleware/subscription.ts:5-7: on a self-hosted server everyone is Pro,
  // even a customer the server has never seen.
  test("selfhost: an unregistered customer is allowed", async () => {
    const { ctx } = await selfhost();
    const res = await ctx.post(
      "/api/ai/summarizePostDetails",
      summarizePostBody("never-registered"),
    );
    expect(res.status).toBe(200);
  });

  // v1 routes/ai/summarizePostDetails.ts:42-45: 403 `Customer is not subscribed`.
  // The current app throws on !ok (APP:api/AI.ts:25-27), but app versions
  // before Hydra commit 711547c returned `response.text()` with no status check
  // (449d4c9:api/AI.ts:22) and render it as the summary, so the body must stay
  // this exact plain text, not a JSON envelope.
  test.each([
    ["never registered", null],
    ["registered but not entitled", { kind: "not_entitled" as const }],
  ])(
    "official: %s → 403 'Customer is not subscribed' (plain text), no model call",
    async (_label, state) => {
      const ctx = await makeApp({ env: OFFICIAL_ENV });
      const id = anonCustomerId(5);
      fakeRevenueCat(ctx.fetch, state === null ? {} : { [id]: state });
      const ai = fakeAI(ctx.fetch, { reply: SUMMARY_TEXT });
      if (state !== null)
        expect((await ctx.post("/api/customers/register", { customerId: id })).status).toBe(200);
      const res = await ctx.post("/api/ai/summarizePostDetails", summarizePostBody(id));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Customer is not subscribed");
      expect(ai.chatCalls()).toHaveLength(0);
    },
  );

  test("official: an entitled customer → 200", async () => {
    const id = anonCustomerId(6);
    const { ctx } = await officialWithPro(id);
    const res = await ctx.post("/api/ai/summarizePostDetails", summarizePostBody(id));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SUMMARY_TEXT);
  });

  // v1 services/AIUsage.ts:37,97 + routes/ai/summarizePostDetails.ts:47-50:
  // 429 `Monthly usage limit exceeded` once the month's spend reaches the cap.
  // Same old-app reasoning as the 403: the body is shown verbatim.
  test("official: over the monthly cap → 429 'Monthly usage limit exceeded'; other customers unaffected", async () => {
    const id = anonCustomerId(7);
    const other = anonCustomerId(8);
    const { ctx, rc } = await officialWithPro(
      id,
      { usage: HUGE_USAGE },
      { AI_MONTHLY_LIMIT_USD: "0.01" },
    );
    expect((await ctx.post("/api/ai/summarizePostDetails", summarizePostBody(id))).status).toBe(
      200,
    );
    const res = await ctx.post("/api/ai/summarizePostDetails", summarizePostBody(id));
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Monthly usage limit exceeded");

    rc.set(other, { kind: "entitled", expiresAt: null });
    expect((await ctx.post("/api/customers/register", { customerId: other })).status).toBe(200);
    expect((await ctx.post("/api/ai/summarizePostDetails", summarizePostBody(other))).status).toBe(
      200,
    );
  });

  // 400 replaces v1's 500
  // (v1 routes/ai/summarizePostDetails.ts:39-41 threw from req.json()/zod).
  test.each([
    ["not JSON", "{"],
    [
      "no postText",
      JSON.stringify({ customerId: "abc", subreddit: "s", postTitle: "t", postAuthor: "a" }),
    ],
    [
      "no customerId",
      JSON.stringify({ subreddit: "s", postTitle: "t", postAuthor: "a", postText: "x" }),
    ],
  ])("%s → 400, no model call", async (_label, body) => {
    const { ctx, ai } = await selfhost();
    const res = await ctx.request("/api/ai/summarizePostDetails", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(ai.chatCalls()).toHaveLength(0);
  });
});

// ------------------------------------------------------- summarizeComments

describe("POST /api/ai/summarizeComments", () => {
  // v1 routes/ai/summarizeComments.ts:63-65; APP:api/AI.ts:53 `response.text()`.
  test("200 with the raw summary text", async () => {
    const { ctx, ai } = await selfhost();
    const body = summarizeCommentsBody(anonCustomerId(10), "summary", [
      "MARKER-COMMENT-1",
      "MARKER-COMMENT-2",
    ]);
    const res = await ctx.post("/api/ai/summarizeComments", body);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SUMMARY_TEXT);
    const sent = ai.chatCalls()[0]!.body ?? "";
    expect(sent).toContain("MARKER-COMMENT-1");
    expect(sent).toContain("MARKER-COMMENT-2");
  });

  // APP:api/AI.ts:36-38,46: top 5 comments, each ≤ 3,000 chars; postSummary ≤ 15,000.
  test("the largest request the current app sends is accepted", async () => {
    const { ctx } = await selfhost();
    const body = {
      ...summarizeCommentsBody(
        anonCustomerId(11),
        "p".repeat(15_000),
        Array.from({ length: 5 }, () => "c".repeat(3_000)),
      ),
      postTitle: "t".repeat(REDDIT_MAX_TITLE),
      postAuthor: "a".repeat(20),
    };
    const res = await ctx.post("/api/ai/summarizeComments", body);
    expect(res.status).toBe(200);
  });

  // Older installed apps send postSummary UNBOUNDED: before Hydra commit 711547c,
  // api/AI.ts:39 sent `postSummary` as given and the caller passed
  // `postSummary ?? postDetail.text` (711547c^:components/.../PostDetailsComponent.tsx:92-95),
  // i.e. the whole self text when the post summary was off. Reddit caps self
  // text at 40,000 chars, so the server must accept that much here.
  test("old apps: a raw 40,000-char self text as postSummary is accepted", async () => {
    const { ctx } = await selfhost();
    const res = await ctx.post(
      "/api/ai/summarizeComments",
      summarizeCommentsBody(anonCustomerId(12), "x".repeat(REDDIT_MAX_SELFTEXT)),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SUMMARY_TEXT);
  });

  // v1 routes/ai/summarizeComments.ts:43-46 (and the old-app note above).
  test("official: not entitled → 403 'Customer is not subscribed'", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    fakeRevenueCat(ctx.fetch);
    const ai = fakeAI(ctx.fetch);
    const res = await ctx.post(
      "/api/ai/summarizeComments",
      summarizeCommentsBody(anonCustomerId(13)),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Customer is not subscribed");
    expect(ai.chatCalls()).toHaveLength(0);
  });

  // v1 routes/ai/summarizeComments.ts:48-51
  test("official: over the monthly cap → 429 'Monthly usage limit exceeded'", async () => {
    const id = anonCustomerId(14);
    const { ctx } = await officialWithPro(
      id,
      { usage: HUGE_USAGE },
      { AI_MONTHLY_LIMIT_USD: "0.01" },
    );
    expect((await ctx.post("/api/ai/summarizeComments", summarizeCommentsBody(id))).status).toBe(
      200,
    );
    const res = await ctx.post("/api/ai/summarizeComments", summarizeCommentsBody(id));
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Monthly usage limit exceeded");
  });

  // The monthly cap is per customer across all Pro features (v1 services/AIUsage.ts:77-98
  // keyed by customerId only): post summaries count against comment summaries.
  test("official: the cap is shared across Pro features", async () => {
    const id = anonCustomerId(15);
    const { ctx } = await officialWithPro(
      id,
      { usage: HUGE_USAGE },
      { AI_MONTHLY_LIMIT_USD: "0.01" },
    );
    expect((await ctx.post("/api/ai/summarizePostDetails", summarizePostBody(id))).status).toBe(
      200,
    );
    expect((await ctx.post("/api/ai/summarizeComments", summarizeCommentsBody(id))).status).toBe(
      429,
    );
  });

  test("no comments field → 400", async () => {
    const { ctx, ai } = await selfhost();
    const { comments: _omit, ...body } = summarizeCommentsBody(anonCustomerId(16));
    const res = await ctx.post("/api/ai/summarizeComments", body);
    expect(res.status).toBe(400);
    expect(ai.chatCalls()).toHaveLength(0);
  });
});

// ------------------------------------------------------------- filterPosts

describe("POST /api/ai/filterPosts", () => {
  // v1 routes/ai/filterPosts.ts:115-124: a JSON object with exactly the
  // requested ids, each a boolean, defaulting to false. The app hides a post
  // when the value is truthy (APP:contexts/SettingsContexts/FiltersContext.tsx:107),
  // so anything but a real boolean (e.g. the string "false") would hide it.
  test("keeps everything: exactly the requested ids, all false", async () => {
    const posts = makePosts(24);
    const { ctx } = await selfhost({ reply: hideReply([]) });
    const res = await ctx.post("/api/ai/filterPosts", filterBody(anonCustomerId(20), posts));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const out = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(posts.map((p) => p.id).sort());
    for (const id of Object.keys(out)) expect(out[id]).toBe(false);
  });

  // contracts.ts PostClassifier: indices 0..n-1 are server-assigned; hiding all
  // of them must mark every requested id true.
  test("hides everything: exactly the requested ids, all true", async () => {
    const posts = makePosts(6);
    const { ctx } = await selfhost({ reply: hideReply(posts.map((_, i) => i)) });
    const res = await ctx.post("/api/ai/filterPosts", filterBody(anonCustomerId(21), posts));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(posts.map((p) => p.id).sort());
    for (const id of Object.keys(out)) expect(out[id]).toBe(true);
  });

  test("a partial hide marks some posts and keeps the key set exact", async () => {
    const posts = makePosts(10);
    const { ctx } = await selfhost({ reply: hideReply([1, 4, 7]) });
    const res = await ctx.post("/api/ai/filterPosts", filterBody(anonCustomerId(22), posts));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(posts.map((p) => p.id).sort());
    expect(Object.values(out).filter((v) => v === true)).toHaveLength(3);
    for (const v of Object.values(out)) expect(typeof v).toBe("boolean");
  });

  // v1 routes/ai/filterPosts.ts:116-122 never echoed extra keys from the model.
  test("model output with out-of-range indices or ids never adds keys", async () => {
    const posts = makePosts(5);
    const reply = JSON.stringify({ hide: [-1, 5, 99, 2], [posts[0]!.id]: true, injected: true });
    const { ctx } = await selfhost({ reply });
    const res = await ctx.post("/api/ai/filterPosts", filterBody(anonCustomerId(23), posts));
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(posts.map((p) => p.id).sort());
    for (const v of Object.values(out)) expect(typeof v).toBe("boolean");
  });

  // v1 routes/ai/filterPosts.ts:110-111 fell back to {} (all false) when the
  // output didn't parse. Whatever v2 answers, the app must end up hiding nothing.
  test("unparseable model output: the app hides nothing", async () => {
    const posts = makePosts(5);
    const { ctx } = await selfhost({ reply: "I'm sorry, I can't help with that." });
    const res = await ctx.post("/api/ai/filterPosts", filterBody(anonCustomerId(24), posts));
    // The route must exist and must not blame the client: 200 (fail open) or 5xx.
    expect(res.status === 200 || res.status >= 500 ? "ok" : res.status).toBe("ok");
    expect(await appVisiblePosts(res, posts)).toEqual(posts.map((p) => p.id));
  });

  // v1 routes/ai/filterPosts.ts:25-30: `text` is optional; link posts send ""
  // (APP:api/AI.ts:70 slices p.text, which is "" for link posts).
  test("posts with empty or missing text are accepted", async () => {
    const posts = [
      { id: "1aaaaa", subreddit: "pics", title: "A link post", text: "" },
      { id: "1bbbbb", subreddit: "pics", title: "No text field" },
    ];
    const { ctx } = await selfhost({ reply: hideReply([]) });
    const res = await ctx.post("/api/ai/filterPosts", {
      customerId: anonCustomerId(25),
      filterDescription: "cats",
      posts,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "1aaaaa": false, "1bbbbb": false });
  });

  // A page is at most 100 posts (Reddit's listing max); titles ≤ 300, text
  // sliced to 500 by APP:api/AI.ts:70. The description is free text from settings.
  test("a full 100-post page at the app's field limits is accepted", async () => {
    const posts = Array.from({ length: 100 }, (_, i) => ({
      id: `1q${i.toString(36).padStart(4, "0")}`,
      subreddit: "s".repeat(21),
      title: "t".repeat(REDDIT_MAX_TITLE),
      text: "x".repeat(500),
    }));
    const { ctx } = await selfhost({ reply: hideReply([]) });
    const res = await ctx.post(
      "/api/ai/filterPosts",
      filterBody(anonCustomerId(26), posts, "d".repeat(1_000)),
    );
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).toHaveLength(100);
  });

  // v1 routes/ai/filterPosts.ts:93-95. The app does not check the status: it
  // calls `response.json()` and keeps every post when that throws or yields no
  // truthy values (APP:api/AI.ts:74, FiltersContext.tsx:105-111).
  test("official: not entitled → 403, and the app hides nothing", async () => {
    const posts = makePosts(4);
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    fakeRevenueCat(ctx.fetch);
    const ai = fakeAI(ctx.fetch, { reply: hideReply([0, 1, 2, 3]) });
    const res = await ctx.post("/api/ai/filterPosts", filterBody(anonCustomerId(27), posts));
    expect(res.status).toBe(403);
    expect(await appVisiblePosts(res, posts)).toEqual(posts.map((p) => p.id));
    expect(ai.chatCalls()).toHaveLength(0);
  });

  // v1 routes/ai/filterPosts.ts:97-100
  test("official: over the monthly cap → 429, and the app hides nothing", async () => {
    const posts = makePosts(4);
    const id = anonCustomerId(28);
    const { ctx } = await officialWithPro(
      id,
      { reply: hideReply([0, 1, 2, 3]), usage: HUGE_USAGE },
      { AI_MONTHLY_LIMIT_USD: "0.01" },
    );
    expect((await ctx.post("/api/ai/filterPosts", filterBody(id, posts))).status).toBe(200);
    const res = await ctx.post("/api/ai/filterPosts", filterBody(id, posts));
    expect(res.status).toBe(429);
    expect(await appVisiblePosts(res, posts)).toEqual(posts.map((p) => p.id));
  });

  test("official: entitled → 200 with the requested ids", async () => {
    const posts = makePosts(3);
    const id = anonCustomerId(29);
    const { ctx } = await officialWithPro(id, { reply: hideReply([0]) });
    const res = await ctx.post("/api/ai/filterPosts", filterBody(id, posts));
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(posts.map((p) => p.id).sort());
  });

  test("a post without an id → 400", async () => {
    const { ctx, ai } = await selfhost({ reply: hideReply([]) });
    const res = await ctx.post("/api/ai/filterPosts", {
      customerId: anonCustomerId(30),
      filterDescription: "cats",
      posts: [{ subreddit: "pics", title: "t", text: "" }],
    });
    expect(res.status).toBe(400);
    expect(ai.chatCalls()).toHaveLength(0);
  });
});

// ------------------------------------------------------------- askQuestion

describe("POST /api/ai/askQuestion", () => {
  /** APP:pages/SettingsPage/Guide.tsx:172 sends at most 3 doc texts; the
   * largest three in APP:constants/documentation.ts are 7,037, 4,811 and 4,609 chars. */
  const APP_DOCS = [7_037, 4_811, 4_609].map((n, i) => `Doc ${i}: ${"x".repeat(n - 7)}`);

  // v1 routes/ai/askQuestion.ts:65: `{ markdown: text }`; the app destructures
  // `{ markdown }` (APP:pages/SettingsPage/Guide.tsx:173).
  test("200 JSON { markdown }", async () => {
    const answer = "Open **Settings → Notifications**.\n\n[Guide](https://hydraapp.io)";
    const { ctx, ai } = await selfhost({ reply: answer });
    const res = await ctx.post("/api/ai/askQuestion", {
      question: "How do I enable notifications?",
      docs: ["MARKER-DOC"],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual({ markdown: answer });
    expect(ai.chatCalls()[0]!.body ?? "").toContain("MARKER-DOC");
  });

  // The request has no customerId (APP:api/AI.ts:92-95) and v1 had no
  // subscription check (v1 routes/ai/askQuestion.ts:44-63): free for everyone.
  test("official: no customer and no RevenueCat involved", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const rc = fakeRevenueCat(ctx.fetch);
    fakeAI(ctx.fetch, { reply: "Answer." });
    const res = await ctx.post("/api/ai/askQuestion", {
      question: "What is Hydra?",
      docs: APP_DOCS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markdown: "Answer." });
    expect(rc.calls()).toHaveLength(0);
  });

  // Per-IP limit. v1 routes/ai/askQuestion.ts:45-52
  // + services/Throttle.ts:34 answered 429 by the 500th request in an hour.
  test("throttled: a 429 within v1's 500 requests", async () => {
    const { ctx } = await selfhost({ reply: "A.", usage: { inputTokens: 1, outputTokens: 1 } });
    const { status, n } = await untilNot200(
      ctx,
      "/api/ai/askQuestion",
      { question: "q", docs: ["d"] },
      500,
    );
    expect({ status, withinV1Limit: n <= 500 }).toEqual({ status: 429, withinV1Limit: true });
  }, 60_000);

  // AI_FREE_DAILY_BUDGET_USD is a daily
  // circuit breaker for the free features, split per feature (askQuestion 90%,
  // createEmbedding 10%), each gated only by its own spend (429).
  // Integrator note: this test first asserted one shared budget (askQuestion
  // spend also blocking createEmbedding). The spec changed after the ai
  // review: one client's askQuestion spend must not take search down for every
  // user. The app cannot tell the difference (it never inspects these 429s).
  test("over the free daily budget → 429, per feature", async () => {
    const { ctx } = await selfhost(
      { reply: "A.", usage: HUGE_USAGE, embeddingTokens: 2_000_000 },
      { AI_FREE_DAILY_BUDGET_USD: "0.0001" },
    );
    expect((await ctx.post("/api/ai/askQuestion", { question: "q", docs: ["d"] })).status).toBe(
      200,
    );
    expect((await ctx.post("/api/ai/askQuestion", { question: "q", docs: ["d"] })).status).toBe(
      429,
    );
    // createEmbedding has its own share: still open, until its own spend uses it up.
    expect((await ctx.post("/api/ai/createEmbedding", { text: "q" })).status).toBe(200);
    expect((await ctx.post("/api/ai/createEmbedding", { text: "q" })).status).toBe(429);
  });

  test("no docs → 400", async () => {
    const { ctx, ai } = await selfhost();
    const res = await ctx.post("/api/ai/askQuestion", { question: "q" });
    expect(res.status).toBe(400);
    expect(ai.chatCalls()).toHaveLength(0);
  });
});

// --------------------------------------------------------- createEmbedding

describe("POST /api/ai/createEmbedding", () => {
  // v1 routes/ai/createEmbedding.ts:23-30: the bare vector as a JSON array. The
  // app always calls the DEFAULT server for this (APP:api/AI.ts:78-85) and dots
  // it against bundled 1536-dim text-embedding-3-small vectors
  // (APP:utils/DocumentationSearch.ts:36,60-100), so the model is pinned.
  test("official: 200 JSON number[] from text-embedding-3-small, no customer needed", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const rc = fakeRevenueCat(ctx.fetch);
    const ai = fakeAI(ctx.fetch);
    const res = await ctx.post("/api/ai/createEmbedding", {
      text: "how do I enable notifications",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const vector: unknown = await res.json();
    expect(Array.isArray(vector)).toBe(true);
    expect(vector).toEqual(DEFAULT_EMBEDDING);
    expect(ai.embeddingCalls()).toHaveLength(1);
    expect(callBody(ai.embeddingCalls()[0]!).model).toBe("text-embedding-3-small");
    expect(rc.calls()).toHaveLength(0);
  });

  // v1 utils/models.ts:231-233: embeddings always go to OpenAI, even when the
  // chat provider is Groq.
  test("embeddings go to OpenAI even with AI_PROVIDER=groq", async () => {
    const { ctx, ai } = await selfhost({}, { AI_PROVIDER: "groq" });
    const res = await ctx.post("/api/ai/createEmbedding", { text: "query" });
    expect(res.status).toBe(200);
    expect(ai.embeddingCalls()[0]!.url).toBe("https://api.openai.com/v1/embeddings");
  });

  // createEmbedding: input ≤ 2,000 chars must be accepted.
  test("a 2,000-char query is accepted", async () => {
    const { ctx } = await selfhost();
    const res = await ctx.post("/api/ai/createEmbedding", { text: "q".repeat(2_000) });
    expect(res.status).toBe(200);
  });

  // createEmbedding: 503 if OPENAI_API_KEY is missing.
  test("no OPENAI_API_KEY → 503 and no upstream call", async () => {
    const ctx = await makeApp({
      env: { HYDRA_MODE: "selfhost", GROQ_API_KEY: "gsk_contract_groq" },
    });
    const ai = fakeAI(ctx.fetch);
    const res = await ctx.post("/api/ai/createEmbedding", { text: "query" });
    expect(res.status).toBe(503);
    expect(ai.embeddingCalls()).toHaveLength(0);
  });

  // createEmbedding: per-IP limit. v1 routes/ai/createEmbedding.ts:11-18
  // + services/Throttle.ts:34 answered 429 by the 1,000th request in an hour.
  test("throttled: a 429 within v1's 1,000 requests", async () => {
    const { ctx } = await selfhost({ embeddingTokens: 1 });
    const { status, n } = await untilNot200(ctx, "/api/ai/createEmbedding", { text: "q" }, 1_000);
    expect({ status, withinV1Limit: n <= 1_000 }).toEqual({ status: 429, withinV1Limit: true });
  }, 60_000);

  test("no text → 400", async () => {
    const { ctx, ai } = await selfhost();
    const res = await ctx.post("/api/ai/createEmbedding", {});
    expect(res.status).toBe(400);
    expect(ai.embeddingCalls()).toHaveLength(0);
  });
});
