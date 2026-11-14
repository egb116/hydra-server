import { describe, expect, test } from "bun:test";
import { RedditError } from "../../../src/modules/contracts";
import {
  createRedditClient,
  getTokenExpiry,
  GQL_URL,
  HOME_URL,
  parseSession,
  REQUEST_TIMEOUT_MS,
  TOKEN_URL,
} from "../../../src/modules/reddit/client";
import { createProxyPool } from "../../../src/modules/reddit/proxyPool";
import { rejection } from "../../helpers";
import { NO_INBOX_RESPONSE, PERSISTED_QUERY_NOT_FOUND } from "./fixtures";
import { creds, fakePool, fakeReddit, jwt, redditDeps, SESSION, websharePage } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const signal = () => new AbortController().signal;
const html403 = () =>
  new Response("<!DOCTYPE html><html>blocked</html>", {
    status: 403,
    headers: { "content-type": "text/html" },
  });

async function redditError(promise: Promise<unknown>): Promise<RedditError> {
  const err = await rejection(promise);
  expect(err).toBeInstanceOf(RedditError);
  return err as RedditError;
}

function setup(options: Parameters<typeof fakeReddit>[2] = {}, pool = fakePool()) {
  const deps = redditDeps();
  const reddit = fakeReddit(deps.fetch, deps.clock, options);
  const client = createRedditClient(deps, pool, { random: () => 0 });
  return { deps, reddit, client, pool };
}

describe("helpers", () => {
  test("getTokenExpiry reads exp; garbage is 0", () => {
    expect(getTokenExpiry(jwt(1_800_000_000_000))).toBe(1_800_000_000_000);
    expect(getTokenExpiry("nope")).toBe(0);
    expect(getTokenExpiry("a.b.c")).toBe(0);
  });

  test("parseSession", () => {
    expect(parseSession(SESSION)).toEqual({ name: "reddit_session", value: "sess-original" });
    for (const bad of ["", "{}", '{"name":1,"value":"x"}', "[]", '"x"']) {
      expect(() => parseSession(bad)).toThrow(RedditError);
    }
  });
});

describe("fetchInbox: handshake", () => {
  test("handshake and query all go through one proxy and one user agent", async () => {
    const { deps, reddit, client, pool } = setup();
    const result = await client.fetchInbox(creds(), signal());

    const calls = deps.fetch.calls;
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `HEAD ${HOME_URL}`,
      `POST ${TOKEN_URL}`,
      `POST ${GQL_URL}`,
    ]);
    const proxies = new Set(calls.map((c) => c.init.proxy));
    expect(proxies).toEqual(new Set(["http://user:pass@p1.proxy:8080"]));
    const agents = new Set(calls.map((c) => c.headers.get("user-agent")));
    expect(agents.size).toBe(1);
    expect(result.persona).toEqual({ proxyKey: "p1", userAgent: [...agents][0] ?? "" });
    expect(result.persona.userAgent).toContain("iPhone OS 16_0");
    for (const c of calls) expect(c.init.timeoutMs).toBe(REQUEST_TIMEOUT_MS);

    // Cookies from the HEAD are sent with the token POST.
    const cookie = reddit.calls("token")[0]?.headers.get("cookie") ?? "";
    expect(cookie).toContain("reddit_session=sess-original");
    expect(cookie).toContain("csrf_token=csrf123");
    expect(cookie).toContain("loid=000000000abc");
    expect(reddit.calls("token")[0]?.body).toBe("{}");

    // The persisted query, exactly as v1 sends it.
    const gql = reddit.calls("gql")[0];
    expect(gql?.headers.get("authorization")).toBe(`Bearer ${reddit.issued[0]}`);
    expect(gql?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(gql?.body ?? "")).toEqual({
      operationName: "GetInboxNotificationFeedV2",
      variables: { pageSize: 50, includeAnnouncement: false },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "bfb3b015837f416e9ceb15d8c8082cd6bfc727124e8ac969eb25332c331ee614",
        },
      },
    });

    expect(result.token).toEqual({
      value: reddit.issued[0] ?? "",
      expiresAt: getTokenExpiry(reddit.issued[0] ?? ""),
    });
    expect(result.renewedSession).toBeNull();
    expect(result.replies.map((r) => r.itemId)).toEqual(["t1_abc123", "t1_def456", "t1_ghi789"]);
    expect(result.unreadCount).toBe(2);
    expect(pool.successes).toEqual(["p1"]);
    expect(pool.failures).toEqual([]);
  });

  test("keeps a persisted persona", async () => {
    const { deps, client } = setup();
    const result = await client.fetchInbox(
      creds({ persona: { proxyKey: "p2", userAgent: "UA/1" } }),
      signal(),
    );
    expect(result.persona).toEqual({ proxyKey: "p2", userAgent: "UA/1" });
    for (const c of deps.fetch.calls) {
      expect(c.headers.get("user-agent")).toBe("UA/1");
      expect(c.init.proxy).toBe("http://user:pass@p2.proxy:8080");
    }
  });

  test("returns the renewed session for the caller to persist", async () => {
    const { client } = setup({ renewSession: "sess-renewed" });
    const result = await client.fetchInbox(creds(), signal());
    expect(result.renewedSession).toBe(
      JSON.stringify({ name: "reddit_session", value: "sess-renewed" }),
    );
  });

  test("home 403 but the logged-out probe loads: session_dead, probe on the same proxy", async () => {
    const { deps, reddit, client, pool } = setup({ homeStatus: 403, probeStatus: 200 });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("session_dead");
    const probe = reddit.calls("probe");
    expect(probe).toHaveLength(1);
    expect(probe[0]?.init.proxy).toBe("http://user:pass@p1.proxy:8080");
    expect(probe[0]?.headers.get("cookie")).toBeNull();
    expect(probe[0]?.headers.get("user-agent")).toBe(
      reddit.calls("home")[0]?.headers.get("user-agent") ?? "",
    );
    expect(reddit.calls("gql")).toHaveLength(0);
    expect(pool.successes).toEqual(["p1"]);
    expect(deps.metrics.get("reddit.inbox.errors.session_dead")).toBe(1);
  });

  test("home 403 and the probe fails too: edge_block, proxy blamed", async () => {
    const { client, pool } = setup({ homeStatus: 403, probeStatus: 403 });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("edge_block");
    expect(pool.failures).toEqual([{ key: "p1", reason: "edge_block" }]);
  });

  test("home 429 with a failing probe: rate_limited, proxy blamed", async () => {
    const { client, pool } = setup({ homeStatus: 429, probeStatus: 429 });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("rate_limited");
    expect(pool.failures).toEqual([{ key: "p1", reason: "rate_limited" }]);
  });

  test("home 503 with a failing probe: server, proxy not blamed", async () => {
    const { client, pool } = setup({ homeStatus: 503, probeStatus: 503 });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("server");
    expect(pool.failures).toEqual([]);
    expect(pool.successes).toEqual([]);
  });

  // During an incident the logged-out page is often served from the CDN cache
  // while logged-in requests fail: that must not mark every session dead.
  test.each([
    [503, "server"],
    [500, "server"],
    [429, "rate_limited"],
  ] as const)("home %i while logged out loads fine: %s, no probe", async (status, kind) => {
    const { reddit, client } = setup({ homeStatus: status, probeStatus: 200 });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe(kind);
    expect(reddit.calls("probe")).toHaveLength(0);
  });

  test("no token_v2 with a 403 HTML edge page: edge_block, proxy blamed", async () => {
    const { deps, client, pool } = setup();
    deps.fetch.on(
      "POST",
      TOKEN_URL,
      () =>
        new Response("<html>Access denied</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    );
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("edge_block");
    expect(pool.failures).toEqual([{ key: "p1", reason: "edge_block" }]);
  });

  test("no csrf_token cookie: edge_block", async () => {
    const { reddit, client, pool } = setup({ setCsrf: false });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("edge_block");
    expect(reddit.calls("token")).toHaveLength(0);
    expect(pool.failures).toEqual([{ key: "p1", reason: "edge_block" }]);
  });

  test("no token_v2 issued: session_dead (v1 SessionError)", async () => {
    const { client } = setup({ issueToken: false, tokenStatus: 400 });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("session_dead");
  });

  test("no token_v2 with a 429 or 5xx is not a dead session", async () => {
    const a = setup({ issueToken: false, tokenStatus: 429 });
    expect((await redditError(a.client.fetchInbox(creds(), signal()))).kind).toBe("rate_limited");
    const b = setup({ issueToken: false, tokenStatus: 502 });
    expect((await redditError(b.client.fetchInbox(creds(), signal()))).kind).toBe("server");
  });

  test("a malformed stored session is session_dead without any request", async () => {
    const { deps, client } = setup();
    const err = await redditError(client.fetchInbox(creds({ session: "garbage" }), signal()));
    expect(err.kind).toBe("session_dead");
    expect(deps.fetch.calls).toHaveLength(0);
  });

  test("different accounts handshake separately", async () => {
    const { reddit, client } = setup();
    await Promise.all([
      client.fetchInbox(creds({ accountId: 1 }), signal()),
      client.fetchInbox(creds({ accountId: 2 }), signal()),
    ]);
    expect(reddit.handshakes).toBe(2);
  });
});

describe("fetchInbox: tokens", () => {
  test("a persisted token that isn't near expiry is used without a handshake", async () => {
    const { deps, reddit, client } = setup();
    const token = { value: jwt(deps.clock.now() + DAY), expiresAt: deps.clock.now() + DAY };
    const result = await client.fetchInbox(creds({ token }), signal());
    expect(reddit.handshakes).toBe(0);
    expect(reddit.calls("gql")[0]?.headers.get("authorization")).toBe(`Bearer ${token.value}`);
    expect(result.token).toEqual(token);
    expect(deps.metrics.get("reddit.tokens.reused")).toBe(1);
  });

  test("a token within 5 minutes of expiry is refreshed", async () => {
    const { deps, reddit, client } = setup();
    const expiresAt = deps.clock.now() + 4 * 60 * 1000;
    const result = await client.fetchInbox(creds({ token: { value: "old", expiresAt } }), signal());
    expect(reddit.handshakes).toBe(1);
    expect(result.token.value).toBe(reddit.issued[0] ?? "");
  });

  test("401 on a persisted token: one fresh handshake, then success", async () => {
    const { deps, reddit, client, pool } = setup();
    // Reddit rejects only the stale token.
    deps.fetch.on("POST", GQL_URL, (call) =>
      call.headers.get("authorization") === "Bearer stale"
        ? new Response("", { status: 401 })
        : Response.json({ data: { notificationInboxV2: { elements: { edges: [] } } } }),
    );
    const token = { value: "stale", expiresAt: deps.clock.now() + DAY };
    const result = await client.fetchInbox(creds({ token }), signal());
    expect(reddit.handshakes).toBe(1);
    expect(reddit.calls("gql")).toHaveLength(2);
    expect(result.token.value).toBe(reddit.issued[0] ?? "");
    expect(result.replies).toEqual([]);
    expect(pool.successes).toEqual(["p1"]);
  });

  test("403 on a persisted (older) token is auth: refreshed and retried", async () => {
    const { deps, reddit, client } = setup();
    deps.fetch.on("POST", GQL_URL, (call) =>
      call.headers.get("authorization") === "Bearer stale"
        ? html403()
        : Response.json({ data: { notificationInboxV2: { elements: { edges: [] } } } }),
    );
    const result = await client.fetchInbox(
      creds({ token: { value: "stale", expiresAt: deps.clock.now() + DAY } }),
      signal(),
    );
    expect(reddit.handshakes).toBe(1);
    expect(result.unreadCount).toBe(0);
  });

  test("401 again after the retry: auth, no third attempt, proxy not blamed", async () => {
    const { reddit, client, pool } = setup({ gql: [() => new Response("", { status: 401 })] });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("auth");
    expect(reddit.handshakes).toBe(2);
    expect(reddit.calls("gql")).toHaveLength(2);
    expect(pool.failures).toEqual([]);
    expect(pool.successes).toEqual(["p1"]);
  });

  test("403 HTML on a fresh token: edge_block without a retry", async () => {
    const { reddit, client, pool } = setup({ gql: [html403] });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("edge_block");
    expect(reddit.handshakes).toBe(1);
    expect(reddit.calls("gql")).toHaveLength(1);
    expect(pool.failures).toEqual([{ key: "p1", reason: "edge_block" }]);
  });

  test("stale token, 403 HTML, then 403 HTML on the fresh one: edge_block", async () => {
    const { deps, reddit, client } = setup({ gql: [html403] });
    const err = await redditError(
      client.fetchInbox(
        creds({ token: { value: "stale", expiresAt: deps.clock.now() + DAY } }),
        signal(),
      ),
    );
    expect(err.kind).toBe("edge_block");
    expect(reddit.calls("gql")).toHaveLength(2);
  });

  test("the retry's renewed session wins", async () => {
    const { reddit, client } = setup({
      renewSession: "sess-renewed",
      gql: [() => new Response("", { status: 401 }), () => Response.json(NO_INBOX_RESPONSE)],
    });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    // NO_INBOX after the retry: the session is dead even though it was renewed.
    expect(err.kind).toBe("session_dead");
    expect(reddit.handshakes).toBe(2);
  });
});

describe("fetchInbox: query classification", () => {
  test("429: rate_limited, proxy blamed", async () => {
    const { client, pool } = setup({ gql: [() => new Response("", { status: 429 })] });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("rate_limited");
    expect(pool.failures).toEqual([{ key: "p1", reason: "rate_limited" }]);
  });

  test("5xx: server, the proxy is neither blamed nor credited", async () => {
    const { client, pool } = setup({ gql: [() => new Response("oops", { status: 502 })] });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("server");
    expect(pool.failures).toEqual([]);
    expect(pool.successes).toEqual([]);
  });

  test("GraphQL errors: graphql_error with Reddit's message, proxy credited", async () => {
    const { client, pool } = setup({ gql: [() => Response.json(PERSISTED_QUERY_NOT_FOUND)] });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("graphql_error");
    expect(err.message).toBe("GetInboxNotificationFeedV2 failed: PersistedQueryNotFound");
    expect(pool.successes).toEqual(["p1"]);
  });

  test("notificationInboxV2 missing: session_dead", async () => {
    const { client } = setup({ gql: [() => Response.json(NO_INBOX_RESPONSE)] });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("session_dead");
  });

  test("notificationInboxV2 null with GraphQL errors: graphql_error, not session_dead", async () => {
    const { client } = setup({
      gql: [
        () =>
          Response.json({
            data: { notificationInboxV2: null },
            errors: [{ message: "Internal server error" }],
          }),
      ],
    });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("graphql_error");
    expect(err.message).toBe("GetInboxNotificationFeedV2 failed: Internal server error");
  });

  test("200 HTML challenge: edge_block", async () => {
    const { client, pool } = setup({
      gql: [
        () => new Response("<html>captcha</html>", { headers: { "content-type": "text/html" } }),
      ],
    });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("edge_block");
    expect(pool.failures).toEqual([{ key: "p1", reason: "edge_block" }]);
  });

  test("connection error: network, proxy blamed", async () => {
    const { deps, client, pool } = setup();
    deps.fetch.on("POST", GQL_URL, () => {
      throw new TypeError("socket hang up");
    });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("network");
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(pool.failures).toEqual([{ key: "p1", reason: "network" }]);
  });

  test("timeout: network, proxy blamed", async () => {
    const { deps, client, pool } = setup();
    deps.fetch.on("HEAD", HOME_URL, () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("network");
    expect(pool.failures).toEqual([{ key: "p1", reason: "network" }]);
  });

  test("the caller's abort is passed to every request and never blames the proxy", async () => {
    const { deps, client, pool } = setup();
    const controller = new AbortController();
    deps.fetch.on("POST", GQL_URL, (call) => {
      expect(call.init.signal).toBe(controller.signal);
      controller.abort(new Error("deadline"));
      throw new DOMException("aborted", "AbortError");
    });
    const err = await redditError(client.fetchInbox(creds(), controller.signal));
    expect(err.kind).toBe("network");
    expect(pool.failures).toEqual([]);
    for (const c of deps.fetch.calls) expect(c.init.signal).toBe(controller.signal);
  });

  test("an already-aborted signal makes no request", async () => {
    const { deps, client } = setup();
    const controller = new AbortController();
    controller.abort();
    expect((await redditError(client.fetchInbox(creds(), controller.signal))).kind).toBe("network");
    expect(deps.fetch.calls).toHaveLength(0);
  });
});

describe("fetchInbox: persona and proxies", () => {
  test("after a proxy-attributed failure the next fetch avoids that proxy", async () => {
    const { deps, client, pool } = setup({ gql: [() => new Response("", { status: 429 })] });
    await rejection(
      client.fetchInbox(creds({ persona: { proxyKey: "p1", userAgent: "UA" } }), signal()),
    );
    deps.fetch.on("POST", GQL_URL, () => Response.json({ data: { notificationInboxV2: {} } }));
    const result = await client.fetchInbox(
      creds({ persona: { proxyKey: "p1", userAgent: "UA" } }),
      signal(),
    );
    expect(pool.assignCalls[1]?.avoidKey).toBe("p1");
    expect(result.persona.proxyKey).toBe("p2");
    // Success clears the avoidance.
    await client.fetchInbox(creds({ persona: result.persona }), signal());
    expect(pool.assignCalls[2]?.avoidKey).toBeNull();
  });

  test("a dead session also retries on a different proxy", async () => {
    const { client, pool } = setup({ gql: [() => Response.json(NO_INBOX_RESPONSE)] });
    await rejection(client.fetchInbox(creds(), signal()));
    await rejection(
      client.fetchInbox(creds({ persona: { proxyKey: "p1", userAgent: null } }), signal()),
    );
    expect(pool.assignCalls[1]?.avoidKey).toBe("p1");
  });

  test("the poller's persisted avoidProxyKey is honoured (e.g. after a restart)", async () => {
    const { client, pool } = setup({});
    const result = await client.fetchInbox(
      creds({ persona: { proxyKey: "p1", userAgent: "UA" }, avoidProxyKey: "p1" }),
      signal(),
    );
    expect(pool.assignCalls[0]?.avoidKey).toBe("p1");
    expect(result.persona.proxyKey).toBe("p2");
  });

  test("a 5xx doesn't move the account off its proxy", async () => {
    const { client, pool } = setup({ gql: [() => new Response("", { status: 500 })] });
    await rejection(client.fetchInbox(creds(), signal()));
    await rejection(
      client.fetchInbox(creds({ persona: { proxyKey: "p1", userAgent: null } }), signal()),
    );
    expect(pool.assignCalls[1]?.avoidKey).toBeNull();
  });

  test("disabled pool: direct requests, proxyKey null", async () => {
    const pool = fakePool([], { enabled: false });
    const { deps, client } = setup({}, pool);
    const result = await client.fetchInbox(
      creds({ persona: { proxyKey: "stale-key", userAgent: "UA" } }),
      signal(),
    );
    expect(result.persona).toEqual({ proxyKey: null, userAgent: "UA" });
    for (const c of deps.fetch.calls) expect("proxy" in c.init).toBe(false);
  });

  test("enabled pool with no healthy proxy: no_proxy, nothing sent direct", async () => {
    const pool = fakePool([]);
    const { deps, client } = setup({}, pool);
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("no_proxy");
    expect(deps.fetch.calls).toHaveLength(0);
    expect(deps.metrics.get("reddit.inbox.errors.no_proxy")).toBe(1);
  });

  test("an enabled pool that returns null still fails closed", async () => {
    const pool = fakePool(["p1"]);
    pool.assign = () => null;
    const { deps, client } = setup({}, pool);
    expect((await redditError(client.fetchInbox(creds(), signal()))).kind).toBe("no_proxy");
    expect(deps.fetch.calls).toHaveLength(0);
  });

  test("with the real pool: loads Webshare, pins the account, cools the proxy down on failure", async () => {
    const deps = redditDeps();
    deps.fetch.on("GET", "https://proxy.webshare.io/", () => ({
      json: websharePage(["a", "b", "c"]),
    }));
    const reddit = fakeReddit(deps.fetch, deps.clock, {
      gql: [
        () => new Response("", { status: 429 }),
        () => Response.json({ data: { notificationInboxV2: {} } }),
      ],
    });
    const pool = createProxyPool({ ...deps, config: { webshareToken: "tok" } });
    const client = createRedditClient(deps, pool);

    await rejection(client.fetchInbox(creds(), signal()));
    const first = reddit.calls("gql")[0]?.init.proxy;
    expect(pool.health().healthy).toBe(2);
    const result = await client.fetchInbox(creds(), signal());
    const second = reddit.calls("gql")[1]?.init.proxy;
    expect(second).not.toBe(first);
    expect(result.persona.proxyKey).not.toBeNull();
    expect(new Set(reddit.calls("home").map((c) => c.init.proxy)).size).toBe(2);
  });
});

const bad502 = () => new Response("oops", { status: 502 });

describe("fetchInbox: credentials from a failed fetch", () => {
  test("a handshake whose query fails (5xx) hands its token back on the error", async () => {
    const { reddit, client } = setup({ gql: [bad502] });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("server");
    expect(err.unused).toEqual({
      token: { value: reddit.issued[0] ?? "", expiresAt: getTokenExpiry(reddit.issued[0] ?? "") },
      renewedSession: null,
    });
  });

  test("the renewed session comes back too, and the retry's renewal wins", async () => {
    const { client } = setup({
      renewSession: "sess-renewed",
      gql: [() => new Response("", { status: 401 }), bad502],
    });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.unused?.renewedSession).toBe(
      JSON.stringify({ name: "reddit_session", value: "sess-renewed" }),
    );
    expect(err.unused?.token).not.toBeNull();
  });

  test("a token Reddit rejected after the retry is not handed back", async () => {
    const { client } = setup({ gql: [() => new Response("", { status: 401 })] });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("auth");
    expect(err.unused).toEqual({ token: null, renewedSession: null });
  });

  test("a dead session drops the token but keeps the renewed cookie", async () => {
    const { client } = setup({
      renewSession: "sess-renewed",
      gql: [() => Response.json(NO_INBOX_RESPONSE)],
    });
    const err = await redditError(client.fetchInbox(creds(), signal()));
    expect(err.kind).toBe("session_dead");
    expect(err.unused).toEqual({
      token: null,
      renewedSession: JSON.stringify({ name: "reddit_session", value: "sess-renewed" }),
    });
  });

  test("a failure on the persisted token, with no handshake, hands nothing back", async () => {
    const { deps, client } = setup({ gql: [bad502] });
    const token = { value: jwt(deps.clock.now() + DAY), expiresAt: deps.clock.now() + DAY };
    const err = await redditError(client.fetchInbox(creds({ token }), signal()));
    expect(err.unused).toBeUndefined();
  });
});

describe("fetchInbox: waiting for the pool", () => {
  test("the caller's deadline cuts a pool that is still loading; no request, no blame", async () => {
    const pool = fakePool();
    const loading = Promise.withResolvers<void>();
    pool.ready = () => loading.promise;
    const { deps, client } = setup({}, pool);
    const controller = new AbortController();
    const fetching = client.fetchInbox(creds(), controller.signal);
    controller.abort(new Error("deadline"));
    const err = await redditError(fetching);
    expect(err.kind).toBe("network");
    expect(deps.fetch.calls).toHaveLength(0);
    expect(pool.assignCalls).toHaveLength(0);
    expect(pool.failures).toEqual([]);
    loading.resolve();
  });
});
