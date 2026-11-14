import type { ProxyPool, RedditCredentials } from "../../../src/modules/contracts";
import { RedditError } from "../../../src/modules/contracts";
import { GQL_URL, HOME_URL, TOKEN_URL } from "../../../src/modules/reddit/client";
import { createMetrics, type Metrics } from "../../../src/lib/metrics";
import {
  captureLogger,
  type CapturedLogger,
  fakeClock,
  type FakeClock,
  fakeFetch,
  type FakeFetch,
  type FetchCall,
  recordingAlerter,
  type RecordingAlerter,
} from "../../helpers";
import { FULL_INBOX } from "./fixtures";

export interface RedditTestDeps {
  clock: FakeClock;
  fetch: FakeFetch;
  log: CapturedLogger;
  alerter: RecordingAlerter;
  metrics: Metrics;
}

/** Lightweight deps (no database) for the reddit module. */
export function redditDeps(): RedditTestDeps {
  return {
    clock: fakeClock(),
    fetch: fakeFetch(),
    log: captureLogger(),
    alerter: recordingAlerter(),
    metrics: createMetrics(),
  };
}

const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** An unsigned JWT with the given exp (epoch ms), like token_v2. */
export function jwt(expMs: number, extra: Record<string, unknown> = {}): string {
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ sub: "t2_user", exp: Math.floor(expMs / 1000), ...extra })}.sig`;
}

export const SESSION = JSON.stringify({ name: "reddit_session", value: "sess-original" });

export function creds(overrides: Partial<RedditCredentials> = {}): RedditCredentials {
  return {
    accountId: 7,
    username: "hydra_user",
    session: SESSION,
    token: null,
    persona: { proxyKey: null, userAgent: null },
    ...overrides,
  };
}

/** A response carrying several Set-Cookie headers. */
export function withCookies(
  status: number,
  cookies: string[],
  body: string | null = null,
): Response {
  const headers = new Headers();
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(body, { status, headers });
}

export interface FakeRedditOptions {
  /** Status of the logged-in HEAD of the home page. */
  homeStatus?: number;
  /** Status of the logged-out probe HEAD. */
  probeStatus?: number;
  /** Whether the home page sets csrf_token. */
  setCsrf?: boolean;
  /** Status of the token POST; it sets token_v2 unless issueToken is false. */
  tokenStatus?: number;
  issueToken?: boolean;
  /** A renewed reddit_session value set by the home page. */
  renewSession?: string;
  /** The tokens handed out, in order (default: one fresh JWT per handshake). */
  tokens?: string[];
  /** Responders for the GraphQL query, in order; the last one repeats. */
  gql?: ((call: FetchCall) => Response | Promise<Response>)[];
}

export interface FakeReddit {
  handshakes: number;
  issued: string[];
  calls(kind: "home" | "probe" | "token" | "gql"): FetchCall[];
}

/** Scripts reddit.com and the GraphQL endpoint on a FakeFetch. */
export function fakeReddit(
  fetch: FakeFetch,
  clock: FakeClock,
  options: FakeRedditOptions = {},
): FakeReddit {
  const state: FakeReddit = {
    handshakes: 0,
    issued: [],
    calls: (kind) =>
      fetch.calls.filter((c) => {
        if (kind === "gql") return c.url === GQL_URL;
        if (kind === "token") return c.url === TOKEN_URL;
        if (c.url !== HOME_URL) return false;
        const hasSession = (c.headers.get("cookie") ?? "").includes("reddit_session=");
        return kind === "home" ? hasSession : !hasSession;
      }),
  };
  let gqlIndex = 0;
  const gql = options.gql ?? [() => Response.json(FULL_INBOX)];

  fetch.on("HEAD", HOME_URL, (call) => {
    const loggedIn = (call.headers.get("cookie") ?? "").includes("reddit_session=");
    if (!loggedIn) return new Response(null, { status: options.probeStatus ?? 200 });
    state.handshakes++;
    const cookies = ["loid=000000000abc; Domain=reddit.com; Path=/; Secure"];
    if (options.setCsrf !== false)
      cookies.push("csrf_token=csrf123; Path=/; Secure; SameSite=Strict");
    if (options.renewSession) {
      cookies.push(`reddit_session=${options.renewSession}; Domain=reddit.com; Path=/; HttpOnly`);
    }
    return withCookies(options.homeStatus ?? 200, cookies);
  });
  fetch.on("POST", TOKEN_URL, () => {
    if (options.issueToken === false)
      return new Response("{}", { status: options.tokenStatus ?? 400 });
    const token =
      options.tokens?.[state.issued.length] ??
      jwt(clock.now() + 24 * 60 * 60 * 1000, { n: state.issued.length });
    state.issued.push(token);
    return withCookies(options.tokenStatus ?? 400, [`token_v2=${token}; Path=/; Secure`], "{}");
  });
  fetch.on("POST", GQL_URL, (call) => {
    const responder = gql[Math.min(gqlIndex, gql.length - 1)];
    gqlIndex++;
    if (!responder) throw new Error("no gql responder");
    return responder(call);
  });
  return state;
}

export interface FakePool extends ProxyPool {
  successes: string[];
  failures: { key: string; reason: string }[];
  assignCalls: {
    accountId: number;
    currentKey: string | null;
    avoidKey: string | null | undefined;
  }[];
}

/** A ProxyPool fake: a fixed key list, keeps the current key, else the first non-avoided one. */
export function fakePool(
  keys: string[] = ["p1", "p2"],
  options: { enabled?: boolean } = {},
): FakePool {
  const enabled = options.enabled ?? true;
  const pool: FakePool = {
    enabled,
    successes: [],
    failures: [],
    assignCalls: [],
    ready: async () => {},
    assign(accountId, currentKey, avoidKey) {
      pool.assignCalls.push({ accountId, currentKey, avoidKey });
      if (!enabled) return null;
      const key =
        currentKey !== null && keys.includes(currentKey) && currentKey !== avoidKey
          ? currentKey
          : (keys.find((k) => k !== avoidKey) ?? keys[0]);
      if (key === undefined) throw new RedditError("no_proxy", "none");
      return { key, url: `http://user:pass@${key}.proxy:8080` };
    },
    reportSuccess(key) {
      pool.successes.push(key);
    },
    reportFailure(key, reason) {
      pool.failures.push({ key, reason });
    },
    health: () => ({
      configured: enabled,
      total: keys.length,
      healthy: keys.length,
      lastRefreshAt: null,
      lastRefreshError: null,
    }),
  };
  return pool;
}

/** A Webshare list page. */
export function websharePage(
  ids: (string | number)[],
  next: string | null = null,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    count: ids.length,
    next,
    previous: null,
    results: ids.map((id, i) => ({
      id: String(id),
      username: `user${id}`,
      password: `pass${id}`,
      proxy_address: `10.0.0.${i + 1}`,
      port: 8000 + i,
      valid: true,
      last_verification: "2026-11-10T00:00:00Z",
      country_code: "US",
      city_name: "Ashburn",
      asn_name: "Example",
      asn_number: 64500,
      high_country_confidence: true,
      created_at: "2026-01-01T00:00:00Z",
      ...overrides,
    })),
  };
}
