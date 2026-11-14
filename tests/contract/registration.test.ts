/**
 * Legacy contract: POST /api/customers/register and POST /api/notifications/register.
 * APP = C:/…/Hydra (the mobile app), v1 = the v1 server files in this repo.
 *
 * Entitlement is not visible in either response (both are always `success`),
 * so its effect is observed the way the app observes it: through a Pro AI
 * route, which v1 gated on the row registration wrote
 * (v1 middleware/subscription.ts:12-18; routes/ai/summarizePostDetails.ts:42-45).
 */
import { describe, expect, test } from "bun:test";
import {
  OFFICIAL_ENV,
  RC_API_KEY,
  SELFHOST_ENV,
  accountRows,
  anonCustomerId,
  deviceCount,
  deviceUsernames,
  expoPushToken,
  fakeAI,
  fakeRevenueCat,
  rcCustomerUrl,
  sessionFor,
  useContractApps,
  type ContractApp,
} from "../helpers/contractApp";
import { FAKE_NOW } from "../helpers/index";
import { fakePush, fakeReddit, reply } from "../helpers/poller-push";
import { secretBoxFromConfig } from "../../src/lib/crypto";
import { createPoller } from "../../src/modules/poller";
import { MAX_ACCOUNTS_PER_CUSTOMER } from "../../src/modules/registration";

const makeApp = useContractApps();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The request APP:api/AI.ts:12-24 sends (bounded the same way). */
function summarizePostBody(customerId: string) {
  return {
    customerId,
    subreddit: "hydraapp",
    postTitle: "A long post",
    postAuthor: "someone",
    postText: "Long text. ".repeat(100),
  };
}

/**
 * Whether the customer can use Pro AI, as the app perceives it: the current
 * app treats any non-2xx as a failed summary (APP:api/AI.ts:25-27).
 */
async function canUsePro(ctx: ContractApp, customerId: string): Promise<number> {
  const res = await ctx.post("/api/ai/summarizePostDetails", summarizePostBody(customerId));
  return res.status;
}

/** APP:api/Customer.ts:10-13 sends `JSON.stringify(customer)` with `{ customerId }` (APP:contexts/SubscriptionsContext.tsx:224-226). */
function registerCustomer(
  ctx: ContractApp,
  customerId: string,
  extra: Record<string, unknown> = {},
) {
  return ctx.post("/api/customers/register", { customerId, ...extra });
}

/** APP:api/Notifications.ts:9-16 sends `{ customerId, pushToken, accounts }`. */
function registerNotifications(
  ctx: ContractApp,
  customerId: string,
  pushToken: string,
  accounts: { username: string; session: string }[],
) {
  return ctx.post("/api/notifications/register", { customerId, pushToken, accounts });
}

function withSessions(...usernames: string[]) {
  return usernames.map((username) => ({ username, session: sessionFor(username) }));
}

describe("POST /api/customers/register", () => {
  // v1 routes/customers/registerCustomer.ts:30 answers `success`. Current app
  // ignores the body (APP:api/Customer.ts:10-13); app versions before Hydra
  // commit 71de268 called `response.json()` on it inside a try/catch, so a
  // plain-text body has always been harmless there.
  test("selfhost: success, and RevenueCat is never called", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const rc = fakeRevenueCat(ctx.fetch);
    fakeAI(ctx.fetch);
    const id = anonCustomerId(1);
    const res = await registerCustomer(ctx, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(rc.calls()).toHaveLength(0);
    // v1 middleware/subscription.ts:5-7: a self-hosted server treats everyone as Pro.
    expect(await canUsePro(ctx, id)).toBe(200);
  });

  // v1 services/RevenueCat.ts:42-61: GET the customer and look for entitlement
  // entla7f4253fb6, with the path segment encoded.
  test("official: an entitled customer becomes Pro", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(2);
    const rc = fakeRevenueCat(ctx.fetch, {
      [id]: { kind: "entitled", expiresAt: FAKE_NOW + 30 * 24 * HOUR },
    });
    fakeAI(ctx.fetch);
    const res = await registerCustomer(ctx, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(rc.calls().length).toBeGreaterThanOrEqual(1);
    const call = rc.calls()[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(rcCustomerUrl(id));
    // v1 services/RevenueCat.ts:51
    expect(call.headers.get("authorization")).toBe(`Bearer ${RC_API_KEY}`);
    expect(await canUsePro(ctx, id)).toBe(200);
  });

  test("official: a lifetime entitlement (expires_at null) is Pro", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(3);
    fakeRevenueCat(ctx.fetch, { [id]: { kind: "entitled", expiresAt: null } });
    fakeAI(ctx.fetch);
    expect((await registerCustomer(ctx, id)).status).toBe(200);
    expect(await canUsePro(ctx, id)).toBe(200);
  });

  // v1 services/RevenueCat.ts:59-61: only entla7f4253fb6 counts.
  // v1 routes/ai/summarizePostDetails.ts:42-45: 403 `Customer is not subscribed`.
  test.each([
    ["has only another entitlement", { kind: "not_entitled" as const }],
    ["is unknown to RevenueCat (404)", { kind: "missing" as const }],
  ])("official: a customer who %s gets success but is not Pro", async (_label, state) => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(4);
    fakeRevenueCat(ctx.fetch, { [id]: state });
    const ai = fakeAI(ctx.fetch);
    const res = await registerCustomer(ctx, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(await canUsePro(ctx, id)).toBe(403);
    expect(ai.chatCalls()).toHaveLength(0);
  });

  // Success even if RevenueCat is down; the app
  // ignores the result (APP:api/Customer.ts:10-15). v1 answered 500 here.
  test.each([
    ["500", { kind: "error" as const, status: 500 }],
    ["503", { kind: "error" as const, status: 503 }],
    ["429", { kind: "error" as const, status: 429 }],
    ["a network error", { kind: "network_error" as const }],
  ])("official: RevenueCat %s still answers success", async (_label, state) => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(5);
    fakeRevenueCat(ctx.fetch, { [id]: state });
    fakeAI(ctx.fetch);
    const res = await registerCustomer(ctx, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    // Nothing known yet, so not Pro.
    expect(await canUsePro(ctx, id)).toBe(403);
  });

  // RevenueCat 429/5xx keep the last known state.
  test("official: RevenueCat failing later keeps the customer Pro", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(6);
    const rc = fakeRevenueCat(ctx.fetch, { [id]: { kind: "entitled", expiresAt: null } });
    fakeAI(ctx.fetch);
    expect((await registerCustomer(ctx, id)).status).toBe(200);
    rc.set(id, { kind: "error", status: 500 });
    ctx.deps.clock.advance(11 * MINUTE); // past refreshIfStale's 10 min default
    const res = await registerCustomer(ctx, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(await canUsePro(ctx, id)).toBe(200);
  });

  // The app re-registers on every launch where isPro flips true
  // (APP:contexts/SubscriptionsContext.tsx:222-228).
  test("official: idempotent, and a later lapse is picked up", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(7);
    const rc = fakeRevenueCat(ctx.fetch, { [id]: { kind: "entitled", expiresAt: null } });
    fakeAI(ctx.fetch);
    for (let i = 0; i < 3; i++) {
      const res = await registerCustomer(ctx, id);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("success");
    }
    expect(await canUsePro(ctx, id)).toBe(200);
    rc.set(id, { kind: "not_entitled" });
    ctx.deps.clock.advance(11 * MINUTE);
    expect((await registerCustomer(ctx, id)).status).toBe(200);
    expect(await canUsePro(ctx, id)).toBe(403);
  });

  // The app registers when isPro flips to true, right after
  // Purchases.purchasePackage (APP:contexts/SubscriptionsContext.tsx:222-228).
  // A not-Pro check minutes earlier (say a reconcile that saw the old
  // subscription lapse) must not keep the new purchase out for 10 minutes.
  test("official: a purchase minutes after a not-Pro check is picked up at once", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(10);
    const rc = fakeRevenueCat(ctx.fetch, { [id]: { kind: "not_entitled" } });
    fakeAI(ctx.fetch);
    expect((await registerCustomer(ctx, id)).status).toBe(200);
    expect(await canUsePro(ctx, id)).toBe(403);
    ctx.deps.clock.advance(3 * MINUTE);
    rc.set(id, { kind: "entitled", expiresAt: FAKE_NOW + 30 * 24 * HOUR });
    expect((await registerCustomer(ctx, id)).status).toBe(200);
    expect(await canUsePro(ctx, id)).toBe(200);
  });

  // APP:api/Customer.ts:3-6 types the body as `{ customerId; pushToken? }`, so
  // an extra pushToken must be accepted, not rejected by a strict schema.
  test("an extra pushToken field is accepted", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(8);
    fakeRevenueCat(ctx.fetch, { [id]: { kind: "entitled", expiresAt: null } });
    const res = await registerCustomer(ctx, id, { pushToken: expoPushToken(8) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
  });

  // React Native's fetch (whatwg-fetch) adds `Content-Type: text/plain;charset=UTF-8`
  // to a string body that has none; the body must still be parsed as JSON.
  test("a text/plain Content-Type is still parsed as JSON", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const res = await ctx.request("/api/customers/register", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ customerId: anonCustomerId(9) }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
  });

  // 400 replaces v1's 500 for invalid input
  // (v1 routes/customers/registerCustomer.ts:11-12 threw from req.json()/zod).
  test.each([
    ["not JSON", "customerId=abc"],
    ["no customerId", JSON.stringify({})],
    ["a numeric customerId", JSON.stringify({ customerId: 12345 })],
    ["an empty customerId", JSON.stringify({ customerId: "" })],
  ])("%s → 400", async (_label, body) => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const rc = fakeRevenueCat(ctx.fetch);
    const res = await ctx.request("/api/customers/register", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(rc.calls()).toHaveLength(0);
  });
});

describe("POST /api/notifications/register", () => {
  // v1 routes/notifications/registerNotifications.ts:75 answers `success`; the
  // app returns `response.text()` (APP:api/Notifications.ts:16) and its caller
  // ignores it (APP:contexts/SettingsContexts/NotificationsContext.tsx:62).
  test("selfhost: success, RevenueCat never called, accounts stored encrypted", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const rc = fakeRevenueCat(ctx.fetch);
    const id = anonCustomerId(20);
    const token = expoPushToken(20);
    const res = await registerNotifications(ctx, id, token, withSessions("alice", "bob"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(rc.calls()).toHaveLength(0);
    expect(deviceUsernames(ctx.deps.sqlite, token)).toEqual(["alice", "bob"]);
    // v1 routes/notifications/registerNotifications.ts:43 encrypted the session.
    const rows = accountRows(ctx.deps.sqlite);
    expect(rows.map((r) => r.username)).toEqual(["alice", "bob"]);
    for (const row of rows) {
      expect(row.customerId).toBe(id);
      expect(row.sessionEnc).not.toContain("reddit_session");
      expect(row.sessionEnc).not.toContain(`${row.username}-v1`);
    }
  });

  test("official: entitled customer → success and the encoded RevenueCat URL", async () => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(21);
    const rc = fakeRevenueCat(ctx.fetch, {
      [id]: { kind: "entitled", expiresAt: FAKE_NOW + 24 * HOUR },
    });
    fakeAI(ctx.fetch);
    const token = expoPushToken(21);
    const res = await registerNotifications(ctx, id, token, withSessions("alice"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(rc.calls().map((c) => c.url)).toContain(rcCustomerUrl(id));
    expect(deviceUsernames(ctx.deps.sqlite, token)).toEqual(["alice"]);
    // v1 routes/notifications/registerNotifications.ts:24-39 also wrote the
    // subscription state, so Pro AI works without a customers/register first.
    expect(await canUsePro(ctx, id)).toBe(200);
  });

  // v1 stored the accounts regardless of entitlement (registerNotifications.ts:26-62);
  // the response is success either way. v2 stores nothing for a customer not
  // known to be Pro (only Pro accounts are polled, so the rows would only hold
  // sessions and disk); the app re-registers on its next launch as Pro.
  test.each([
    ["not entitled", { kind: "not_entitled" as const }],
    ["RevenueCat 500", { kind: "error" as const, status: 500 }],
    ["RevenueCat unreachable", { kind: "network_error" as const }],
  ])("official: %s → still success", async (_label, state) => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const id = anonCustomerId(22);
    fakeRevenueCat(ctx.fetch, { [id]: state });
    const res = await registerNotifications(ctx, id, expoPushToken(22), withSessions("alice"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(deviceCount(ctx.deps.sqlite)).toBe(0);
    expect(accountRows(ctx.deps.sqlite)).toEqual([]);
  });

  // The app re-registers on every change of isPro, notificationsEnabled or
  // accounts (APP:contexts/SettingsContexts/NotificationsContext.tsx:80-84).
  test("idempotent: the same registration twice leaves the same state", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const id = anonCustomerId(23);
    const token = expoPushToken(23);
    for (let i = 0; i < 2; i++) {
      const res = await registerNotifications(ctx, id, token, withSessions("alice", "bob"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("success");
    }
    expect(deviceCount(ctx.deps.sqlite)).toBe(1);
    expect(deviceUsernames(ctx.deps.sqlite, token)).toEqual(["alice", "bob"]);
    expect(accountRows(ctx.deps.sqlite).map((r) => r.username)).toEqual(["alice", "bob"]);
  });

  // v1 routes/notifications/registerNotifications.ts:64-73: "The app sends every
  // account it has, so the rest were removed from it."
  test("an account missing from the next registration is unlinked and dropped", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const id = anonCustomerId(24);
    const token = expoPushToken(24);
    expect((await registerNotifications(ctx, id, token, withSessions("alice", "bob"))).status).toBe(
      200,
    );
    expect((await registerNotifications(ctx, id, token, withSessions("alice"))).status).toBe(200);
    expect(deviceUsernames(ctx.deps.sqlite, token)).toEqual(["alice"]);
    expect(accountRows(ctx.deps.sqlite).map((r) => r.username)).toEqual(["alice"]);
  });

  // APP:contexts/SettingsContexts/NotificationsContext.tsx:50-62 drops accounts
  // without a stored session, so `accounts` can be empty.
  test("an empty account list is accepted", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const id = anonCustomerId(25);
    const token = expoPushToken(25);
    expect((await registerNotifications(ctx, id, token, withSessions("alice"))).status).toBe(200);
    const res = await registerNotifications(ctx, id, token, []);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(deviceUsernames(ctx.deps.sqlite, token)).toEqual([]);
    expect(accountRows(ctx.deps.sqlite)).toEqual([]);
  });

  // Multi-device: the push token is the device
  // identity, and a registration never touches other devices' links. (v1 kept
  // one push token per customer and let the last device win.)
  test("multi-device: two push tokens for one customer keep separate account sets", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const id = anonCustomerId(26);
    const phone = expoPushToken(261);
    const tablet = expoPushToken(262);
    expect(
      (await registerNotifications(ctx, id, phone, withSessions("alice", "shared"))).status,
    ).toBe(200);
    expect(
      (await registerNotifications(ctx, id, tablet, withSessions("bob", "shared"))).status,
    ).toBe(200);
    expect(deviceUsernames(ctx.deps.sqlite, phone)).toEqual(["alice", "shared"]);
    expect(deviceUsernames(ctx.deps.sqlite, tablet)).toEqual(["bob", "shared"]);

    // The phone drops "shared": the tablet keeps it, and the account survives.
    expect((await registerNotifications(ctx, id, phone, withSessions("alice"))).status).toBe(200);
    expect(deviceUsernames(ctx.deps.sqlite, phone)).toEqual(["alice"]);
    expect(deviceUsernames(ctx.deps.sqlite, tablet)).toEqual(["bob", "shared"]);
    expect(accountRows(ctx.deps.sqlite).map((r) => r.username)).toEqual(["alice", "bob", "shared"]);

    // The tablet unregisters everything; the phone is untouched.
    expect((await registerNotifications(ctx, id, tablet, [])).status).toBe(200);
    expect(deviceUsernames(ctx.deps.sqlite, phone)).toEqual(["alice"]);
    expect(accountRows(ctx.deps.sqlite).map((r) => r.username)).toEqual(["alice"]);
  });

  test("a session update re-registers the same account without duplicating it", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const id = anonCustomerId(27);
    const token = expoPushToken(27);
    const first = [{ username: "alice", session: sessionFor("alice", 1) }];
    const second = [{ username: "alice", session: sessionFor("alice", 2) }];
    expect((await registerNotifications(ctx, id, token, first)).status).toBe(200);
    const before = accountRows(ctx.deps.sqlite);
    expect((await registerNotifications(ctx, id, token, second)).status).toBe(200);
    const after = accountRows(ctx.deps.sqlite);
    expect(after).toHaveLength(1);
    expect(after[0]!.username).toBe("alice");
    // v1 registerNotifications.ts:54-56 replaced the stored session.
    expect(after[0]!.sessionEnc).not.toBe(before[0]!.sessionEnc);
  });

  // Multi-device: two devices of one customer (RevenueCat shares the
  // customerId across a user's devices) logged in to the same Reddit account
  // separately both get its notifications.
  test("two devices registering the same username with different sessions both receive its pushes", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const id = anonCustomerId(32);
    const phone = expoPushToken(321);
    const tablet = expoPushToken(322);
    const reddit = fakeReddit();
    const push = fakePush();
    const poller = createPoller(ctx.deps, {
      reddit,
      push,
      secretBox: secretBoxFromConfig(ctx.deps.config),
      random: () => 0.5,
    });
    let n = 0;
    reddit.fallback = () => ({ replies: [reply(`t1_reply${++n}`, ctx.deps.clock.now() - 1)] });
    const poll = async () => {
      const row = ctx.deps.sqlite
        .query<{ id: number }, []>("SELECT id FROM reddit_accounts WHERE username = 'shared_user'")
        .get();
      expect(row).not.toBeNull();
      await poller.checkAccount(row!.id);
    };

    expect((await registerNotifications(ctx, id, phone, withSessions("shared_user"))).status).toBe(
      200,
    );
    expect(
      (
        await registerNotifications(ctx, id, tablet, [
          { username: "shared_user", session: sessionFor("tablet", 1) },
        ])
      ).status,
    ).toBe(200);
    // The phone's app registers again (every launch) with its own session.
    expect((await registerNotifications(ctx, id, phone, withSessions("shared_user"))).status).toBe(
      200,
    );
    for (let i = 0; i < 3; i++) {
      ctx.deps.clock.advance(5 * MINUTE);
      await poll();
    }
    const recipients = new Set(push.sent.flat().map((m) => m.to));
    expect(recipients).toEqual(new Set([phone, tablet]));

    // The account is deleted once no device keeps it.
    expect((await registerNotifications(ctx, id, phone, [])).status).toBe(200);
    expect(accountRows(ctx.deps.sqlite)).toHaveLength(1);
    expect((await registerNotifications(ctx, id, tablet, [])).status).toBe(200);
    expect(accountRows(ctx.deps.sqlite)).toEqual([]);
  });

  // Registration bounds; 400 replaces v1's 500.
  test.each([
    ["not JSON", "not json"],
    ["no pushToken", JSON.stringify({ customerId: anonCustomerId(28), accounts: [] })],
    [
      "no accounts",
      JSON.stringify({ customerId: anonCustomerId(28), pushToken: expoPushToken(28) }),
    ],
    [
      "an account without a session",
      JSON.stringify({
        customerId: anonCustomerId(28),
        pushToken: expoPushToken(28),
        accounts: [{ username: "alice" }],
      }),
    ],
    [
      "more than 50 accounts",
      JSON.stringify({
        customerId: anonCustomerId(28),
        pushToken: expoPushToken(28),
        accounts: withSessions(...Array.from({ length: 51 }, (_, i) => `user${i}`)),
      }),
    ],
    [
      "a session over 16 KB",
      JSON.stringify({
        customerId: anonCustomerId(28),
        pushToken: expoPushToken(28),
        accounts: [{ username: "alice", session: "s".repeat(16 * 1024 + 1) }],
      }),
    ],
    [
      "a pushToken over 256 chars",
      JSON.stringify({ customerId: anonCustomerId(28), pushToken: "x".repeat(257), accounts: [] }),
    ],
  ])("%s → 400", async (_label, body) => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const rc = fakeRevenueCat(ctx.fetch);
    const res = await ctx.request("/api/notifications/register", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(rc.calls()).toHaveLength(0);
    expect(deviceCount(ctx.deps.sqlite)).toBe(0);
  });

  // Upper bounds that a real app can reach must be accepted: 50 accounts with
  // realistic sessions. Only the first
  // MAX_ACCOUNTS_PER_CUSTOMER are stored; the rest are skipped, still "success".
  test("50 accounts with realistic sessions are accepted", async () => {
    const ctx = await makeApp({ env: SELFHOST_ENV });
    const token = expoPushToken(29);
    const names = Array.from({ length: 50 }, (_, i) => `user_${i.toString().padStart(2, "0")}`);
    const res = await registerNotifications(ctx, anonCustomerId(29), token, withSessions(...names));
    expect(res.status).toBe(200);
    expect(deviceUsernames(ctx.deps.sqlite, token)).toHaveLength(MAX_ACCOUNTS_PER_CUSTOMER);
  });
});

describe("customerId validation", () => {
  // `^[A-Za-z0-9$:_.@+\-]{1,128}$` on
  // every route that takes customerId, which closes the RevenueCat URL-aliasing
  // exploit of v1 services/RevenueCat.ts:47 (the id was pasted into the path).
  const BAD_IDS = [
    ["#", "$RCAnonymousID:abc#def"],
    ["?", "$RCAnonymousID:abc?expand=all"],
    ["/", "../../other-project/customers/victim"],
    ["/ (single)", "abc/def"],
    ["%", "abc%2Fdef"],
    ["whitespace", "abc def"],
    ["too long", "a".repeat(129)],
  ] as const;

  const ROUTES: [string, (id: string) => unknown][] = [
    ["/api/customers/register", (customerId) => ({ customerId })],
    [
      "/api/notifications/register",
      (customerId) => ({
        customerId,
        pushToken: expoPushToken(30),
        accounts: withSessions("alice"),
      }),
    ],
    ["/api/ai/summarizePostDetails", (customerId) => summarizePostBody(customerId)],
    [
      "/api/ai/summarizeComments",
      (customerId) => ({
        customerId,
        postTitle: "t",
        postAuthor: "a",
        postSummary: "s",
        comments: ["c"],
      }),
    ],
    [
      "/api/ai/filterPosts",
      (customerId) => ({
        customerId,
        filterDescription: "cats",
        posts: [{ id: "1abcde", subreddit: "pics", title: "t", text: "" }],
      }),
    ],
  ];

  for (const [route, makeBody] of ROUTES) {
    test.each(BAD_IDS)(
      `${route}: customerId with %s → 400, never reaches RevenueCat or a model`,
      async (_label, id) => {
        const ctx = await makeApp({ env: OFFICIAL_ENV });
        const rc = fakeRevenueCat(ctx.fetch, { [id]: { kind: "entitled", expiresAt: null } });
        const ai = fakeAI(ctx.fetch);
        const res = await ctx.post(route, makeBody(id));
        expect(res.status).toBe(400);
        expect(rc.calls()).toHaveLength(0);
        expect(ai.chatCalls()).toHaveLength(0);
        expect(ctx.fetch.calls).toHaveLength(0);
      },
    );
  }

  // Real ids are RevenueCat anonymous ids (APP:contexts/SubscriptionsContext.tsx:87),
  // e.g. `$RCAnonymousID:<32 hex>`; `$` and `:` must pass and be URL-encoded.
  test.each([
    anonCustomerId(31),
    "user.name+tag@example.com",
    "a",
    "A".repeat(128),
    "legacy_id-with-dash",
  ])("accepted: %s", async (id) => {
    const ctx = await makeApp({ env: OFFICIAL_ENV });
    const rc = fakeRevenueCat(ctx.fetch, { [id]: { kind: "entitled", expiresAt: null } });
    const res = await registerCustomer(ctx, id);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    for (const call of rc.calls()) expect(call.url).toBe(rcCustomerUrl(id));
  });
});
