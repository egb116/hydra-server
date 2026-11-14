import type { Clock } from "../../lib/clock";
import { raceSignal } from "../../lib/async";
import { drain, type OutboundFetch, type OutboundInit } from "../../lib/http";
import type { Logger } from "../../lib/log";
import type { Metrics } from "../../lib/metrics";
import {
  type InboxResult,
  type ProxyPool,
  type RedditClient,
  type RedditCredentials,
  RedditError,
  type RedditErrorKind,
  type RedditToken,
} from "../contracts";
import {
  classifyHomeFailure,
  classifyMissingToken,
  classifyQueryResponse,
  homeFailureNeedsProbe,
  proxyVerdict,
  type QueryOutcome,
} from "./classify";
import {
  GetInboxNotificationFeedV2,
  type GqlOperation,
  INBOX_VARIABLES,
  parseInboxData,
} from "./inbox";
import { generateUserAgent } from "./userAgent";

/**
 * Reddit's GraphQL API, the one Reddit's own apps use (ported from v1
 * services/RedditGql.ts). It authenticates with the same token_v2 that
 * www.reddit.com gives logged in browsers, which Reddit only issues in the
 * response to a POST from a page session: a HEAD of the home page first sets
 * the cookies (loid, csrf_token...) that the POST needs. Tokens last 24 hours.
 *
 * One sticky persona (proxy + user agent) per account for the handshake and
 * the query, persisted tokens, explicit error classification, and per-proxy
 * health reporting. The poller's lease means one account is never
 * fetched twice at once, so there is no per-account single-flight here.
 */

export const HOME_URL = "https://www.reddit.com/";
export const TOKEN_URL = "https://www.reddit.com/svc/shreddit/graphql";
export const GQL_URL = "https://cf.gql-fed.reddit.com/";
/** Every Reddit request gets this deadline (and the caller's signal). */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Treat tokens this close to expiring as expired, so requests don't race it. */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** A token younger than this that gets a 403 is not refreshed again: the 403 is about the IP. */
export const FRESH_TOKEN_MS = 60 * 1000;

/** Bound on the per-account avoided-proxy map. */
const MAX_ACCOUNT_ENTRIES = 10_000;

export interface RedditClientDeps {
  fetch: OutboundFetch;
  clock: Clock;
  log: Logger;

  metrics: Metrics;
}

export interface RedditClientOptions {
  /** For tests: replaces Math.random in user agent generation. */
  random?: () => number;
}

interface SessionCookie {
  name: string;
  value: string;
}

interface Handshake {
  token: RedditToken;
  renewedSession: string | null;
  obtainedAt: number;
}

interface RequestContext {
  proxy: string | undefined;
  userAgent: string;
  signal: AbortSignal;
}

/** Map.set that evicts the oldest entry once the map is full. */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_ACCOUNT_ENTRIES && !map.has(key)) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

const callerAbort = (signal: AbortSignal): RedditError =>
  new RedditError("network", "Aborted by the caller", { cause: signal.reason });

/** The JWT's exp in epoch ms, or 0 when it can't be read (v1 getExpiry). */
export function getTokenExpiry(token: string): number {
  try {
    const payload = token.split(".")[1] ?? "";
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof parsed === "object" && parsed !== null && "exp" in parsed) {
      const { exp } = parsed;
      return typeof exp === "number" ? exp * 1000 : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** The app sends the session cookie as JSON {name, value}. Anything else can't be used. */
export function parseSession(session: string): SessionCookie {
  let parsed: unknown;
  try {
    parsed = JSON.parse(session);
  } catch {
    parsed = null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "name" in parsed &&
    "value" in parsed &&
    typeof parsed.name === "string" &&
    typeof parsed.value === "string" &&
    parsed.name !== ""
  ) {
    return { name: parsed.name, value: parsed.value };
  }
  throw new RedditError("session_dead", "The stored session is not a {name, value} cookie");
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw new RedditError("network", "Reading the response failed", { cause: err });
  }
}

export function createRedditClient(
  deps: RedditClientDeps,
  pool: ProxyPool,
  options: RedditClientOptions = {},
): RedditClient {
  const { clock, metrics } = deps;
  const log = deps.log.child({ component: "reddit" });
  const avoidNext = new Map<number, string>();

  /** One request through the persona: proxy, timeout and the caller's signal. */
  const send = async (
    url: string,
    init: Omit<OutboundInit, "timeoutMs" | "signal" | "proxy">,
    ctx: RequestContext,
  ): Promise<Response> => {
    try {
      return await deps.fetch(url, {
        ...init,
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: ctx.signal,
        ...(ctx.proxy === undefined ? {} : { proxy: ctx.proxy }),
      });
    } catch (err) {
      throw new RedditError("network", `${init.method ?? "GET"} ${url} failed`, { cause: err });
    }
  };

  const doHandshake = async (session: SessionCookie, ctx: RequestContext): Promise<Handshake> => {
    metrics.inc("reddit.handshakes");
    const cookies = new Map([[session.name, session.value]]);
    const sendWithCookies = async (
      url: string,
      init: { method: string; headers?: Record<string, string>; body?: string },
    ): Promise<Response> => {
      const res = await send(
        url,
        {
          ...init,
          headers: {
            ...init.headers,
            "User-Agent": ctx.userAgent,
            cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
          },
        },
        ctx,
      );
      for (const setCookie of res.headers.getSetCookie()) {
        const pair = setCookie.split(";")[0] ?? "";
        const split = pair.indexOf("=");
        if (split < 1) continue;
        cookies.set(pair.slice(0, split).trim(), pair.slice(split + 1));
      }
      return res;
    };

    const home = await sendWithCookies(HOME_URL, { method: "HEAD" });
    await drain(home);
    if (home.status >= 400) {
      // A 429 or 5xx is not about the session, whatever a logged-out request
      // gets (during an incident the logged-out page is often served from the
      // CDN cache while logged-in requests fail).
      if (!homeFailureNeedsProbe(home.status)) {
        throw new RedditError(
          classifyHomeFailure(home.status),
          `Failed to load reddit.com: [${home.status}]`,
        );
      }
      // Reddit also answers 403 to a session it no longer accepts. If the same
      // proxy loads the page without the session, the session is the problem.
      const loggedOut = await send(
        HOME_URL,
        { method: "HEAD", headers: { "User-Agent": ctx.userAgent } },
        ctx,
      );
      await drain(loggedOut);
      if (loggedOut.ok) {
        throw new RedditError("session_dead", "Reddit rejected the session. It may have expired.");
      }
      throw new RedditError(
        classifyHomeFailure(home.status),
        `Failed to load reddit.com: [${home.status}]`,
      );
    }
    // Without these cookies no token is issued, whatever the session. A proxy
    // Reddit is wary of gets a challenge page instead, which sets none.
    if (!cookies.has("csrf_token")) {
      throw new RedditError(
        "edge_block",
        "reddit.com didn't set its cookies. The proxy may be blocked.",
      );
    }
    // Reddit rejects the empty body (HTTP 400) but still sets token_v2.
    const post = await sendWithCookies(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await drain(post);
    const token = cookies.get("token_v2");
    if (!token) {
      const kind = classifyMissingToken(post.status, post.headers.get("content-type"));
      throw new RedditError(
        kind,
        kind === "session_dead"
          ? "Reddit did not issue a token. The session may have expired."
          : `Reddit did not issue a token: [${post.status}]`,
      );
    }

    // The HEAD renews the session cookie (it lasts 6 months from its last
    // use), so hand the renewed one back for accounts the app isn't opened on.
    const renewed = cookies.get(session.name);
    const renewedSession =
      renewed && renewed !== session.value ? JSON.stringify({ ...session, value: renewed }) : null;
    return {
      token: { value: token, expiresAt: getTokenExpiry(token) },
      renewedSession,
      obtainedAt: clock.now(),
    };
  };

  const query = async (
    operation: GqlOperation,
    variables: Readonly<Record<string, unknown>>,
    token: RedditToken,
    tokenFresh: boolean,
    ctx: RequestContext,
  ): Promise<QueryOutcome> => {
    const res = await send(
      GQL_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/json",
          "User-Agent": ctx.userAgent,
        },
        body: JSON.stringify({
          operationName: operation.name,
          variables,
          extensions: {
            persistedQuery: { version: 1, sha256Hash: operation.hash },
          },
        }),
      },
      ctx,
    );
    const body = await readText(res);
    return classifyQueryResponse({
      status: res.status,
      contentType: res.headers.get("content-type"),
      body,
      tokenFresh,
      ...(operation.rootField === undefined ? {} : { rootField: operation.rootField }),
    });
  };

  const usable = (token: RedditToken | null | undefined): token is RedditToken =>
    token != null && token.expiresAt - TOKEN_EXPIRY_MARGIN_MS > clock.now();

  const run = async (
    creds: RedditCredentials,
    ctx: RequestContext,
  ): Promise<Omit<InboxResult, "persona">> => {
    const op = GetInboxNotificationFeedV2;
    const session = parseSession(creds.session);
    // What this fetch's handshakes obtained, handed back on failure too.
    const got: { token: RedditToken | null; renewedSession: string | null } = {
      token: null,
      renewedSession: null,
    };
    let obtainedAt: number | null = null;
    const handshake = async (): Promise<RedditToken> => {
      const hs = await doHandshake(session, ctx);
      got.token = hs.token;
      got.renewedSession = hs.renewedSession ?? got.renewedSession;
      obtainedAt = hs.obtainedAt;
      return hs.token;
    };
    const isFresh = (): boolean => obtainedAt !== null && clock.now() - obtainedAt < FRESH_TOKEN_MS;

    try {
      let token: RedditToken;
      if (usable(creds.token)) {
        token = creds.token;
        metrics.inc("reddit.tokens.reused");
      } else {
        token = await handshake();
      }
      let outcome = await query(op, INBOX_VARIABLES, token, isFresh(), ctx);
      if (!outcome.ok && outcome.kind === "auth") {
        // Revoked or replaced token (401 = none, 403 = invalid): get a new one, once.
        log.debug("token rejected, refreshing", { accountId: creds.accountId });
        got.token = null;
        token = await handshake();
        outcome = await query(op, INBOX_VARIABLES, token, isFresh(), ctx);
      }
      if (!outcome.ok) {
        throw new RedditError(outcome.kind, `${op.name} failed: ${outcome.message}`);
      }
      return { ...parseInboxData(outcome.data), token, renewedSession: got.renewedSession };
    } catch (err) {
      if (err instanceof RedditError && (got.token !== null || got.renewedSession !== null)) {
        // A token Reddit rejected, or one for a dead session, is not worth keeping.
        const keepToken = err.kind !== "auth" && err.kind !== "session_dead";
        err.unused = {
          token: keepToken ? got.token : null,
          renewedSession: got.renewedSession,
        };
      }
      throw err;
    }
  };

  /** Counts the failure by kind and hands the error back for throwing. */
  const fail = (kind: RedditErrorKind, err: RedditError): RedditError => {
    metrics.inc(`reddit.inbox.errors.${kind}`);
    return err;
  };

  return {
    async fetchInbox(creds, signal) {
      const userAgent = creds.persona.userAgent || generateUserAgent(options.random);
      let assigned: { key: string; url: string } | null;
      try {
        if (signal.aborted) throw callerAbort(signal);
        // Validate the stored session before any request.
        parseSession(creds.session);
        // Only waits when no list has been loaded yet, and never past the caller's deadline.
        await raceSignal(pool.ready(), signal, () => callerAbort(signal));
        // The in-memory verdict wins; the poller's persisted hint covers restarts.
        const avoidKey = avoidNext.get(creds.accountId) ?? creds.avoidProxyKey ?? null;
        assigned = pool.assign(creds.accountId, creds.persona.proxyKey, avoidKey);
      } catch (err) {
        if (err instanceof RedditError) throw fail(err.kind, err);
        throw err;
      }
      // Fail closed: an enabled pool never sends a request direct.
      if (pool.enabled && assigned === null) {
        throw fail("no_proxy", new RedditError("no_proxy", "No proxy assigned"));
      }
      const proxyKey = assigned?.key ?? null;
      const ctx: RequestContext = { proxy: assigned?.url, userAgent, signal };

      try {
        const result = await run(creds, ctx);
        if (proxyKey !== null) pool.reportSuccess(proxyKey);
        avoidNext.delete(creds.accountId);
        metrics.inc("reddit.inbox.ok");
        return { ...result, persona: { proxyKey, userAgent } };
      } catch (thrown) {
        let err: RedditError;
        if (thrown instanceof RedditError) err = thrown;
        else err = new RedditError("network", "Unexpected failure", { cause: thrown });
        // The poller's own deadline is not the proxy's fault.
        const verdict = signal.aborted ? "neutral" : proxyVerdict(err.kind);
        if (proxyKey !== null) {
          if (verdict === "failure") pool.reportFailure(proxyKey, err.kind);
          else if (verdict === "success") pool.reportSuccess(proxyKey);
          // Next time, prefer another proxy: after a proxy-attributed failure
          // (its cooldown may be over by the retry), or a dead session (v2
          // retries those on a different proxy before giving up).
          if (verdict === "failure" || err.kind === "session_dead") {
            setBounded(avoidNext, creds.accountId, proxyKey);
          }
        }
        log.debug("inbox fetch failed", {
          accountId: creds.accountId,
          kind: err.kind,
          proxyKey,
          err,
        });
        throw fail(err.kind, err);
      }
    },
  };
}
