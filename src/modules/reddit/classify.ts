import { isRecord } from "../../lib/http";
import type { RedditErrorKind } from "../contracts";

/**
 * Response classification for Reddit requests.
 * Pure functions, so every branch is unit-testable without a client.
 */

/** How an outcome reflects on the proxy that carried it. */
export type ProxyVerdict = "success" | "failure" | "neutral";

/**
 * network, edge_block and rate_limited are the proxy's fault. A 5xx is
 * Reddit's, and no_proxy never reached a proxy, so neither counts either way.
 * Everything else means Reddit answered through the proxy, so it works.
 */
const VERDICTS: Readonly<Record<RedditErrorKind, ProxyVerdict>> = {
  network: "failure",
  edge_block: "failure",
  rate_limited: "failure",
  server: "neutral",
  no_proxy: "neutral",
  auth: "success",
  session_dead: "success",
  graphql_error: "success",
};

export function proxyVerdict(kind: RedditErrorKind): ProxyVerdict {
  return VERDICTS[kind];
}

/** Whether a response body is a web page (an edge challenge or captcha), not an API answer. */
export function looksLikePage(contentType: string | null, body: string): boolean {
  if (contentType?.toLowerCase().includes("text/html")) return true;
  // JSON never starts with "<"; markup (<!DOCTYPE, <html>, an edge error page) does.
  if (body.trimStart().startsWith("<")) return true;
  return /captcha/i.test(body);
}

/** reddit.com's home page failed (with the session) and loads without it neither. */
export function classifyHomeFailure(status: number): RedditErrorKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "edge_block";
}

/**
 * The logged-in HEAD of the home page failed. Only a 401 or 403 can be about
 * the session (the caller then probes without it); a 429 or 5xx is Reddit's
 * or the proxy's problem whatever the session, so it is classified straight
 * away and never counts toward needs_reauth.
 */
export function homeFailureNeedsProbe(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * The token POST set no token_v2. v1 called this a dead session; keep that
 * unless it's clearly not: a 429, a 5xx, or a 403 web page (an edge block on
 * the proxy, not Reddit's answer about the session).
 */
export function classifyMissingToken(
  status: number,
  contentType: string | null = null,
): RedditErrorKind {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status === 403 && looksLikePage(contentType, "")) return "edge_block";
  return "session_dead";
}

export type QueryOutcome =
  | { ok: true; data: unknown }
  | { ok: false; kind: RedditErrorKind; message: string };

export interface QueryResponse {
  status: number;
  contentType: string | null;
  body: string;
  /** The token came from a handshake under a minute ago. */
  tokenFresh: boolean;
  /**
   * The operation's root field. A response whose `data` lacks it but that
   * carries `errors` is a GraphQL (partial) failure, not an answer about the
   * session.
   */
  rootField?: string;
}

function fail(kind: RedditErrorKind, message: string): QueryOutcome {
  return { ok: false, kind, message };
}

/** Classifies a GraphQL query response. */
export function classifyQueryResponse(res: QueryResponse): QueryOutcome {
  const { status, contentType, body, tokenFresh } = res;
  const page = looksLikePage(contentType, body);

  if (status === 401) return fail("auth", "[401] token rejected");
  if (status === 403) {
    // An older token may have been revoked or replaced: refresh it. A token we
    // just got that is refused with a web page is an IP-level block.
    if (!tokenFresh) return fail("auth", "[403] token rejected");
    if (page) return fail("edge_block", "[403] blocked (HTML response on a fresh token)");
    return fail("auth", "[403] fresh token rejected");
  }
  if (status === 429) return fail("rate_limited", "[429] rate limited");
  if (status >= 500) return fail("server", `[${status}] Reddit server error`);
  if (status >= 400) {
    return page
      ? fail("edge_block", `[${status}] blocked (HTML response)`)
      : fail("graphql_error", `[${status}] request rejected`);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return fail(
      "edge_block",
      page ? `[${status}] HTML instead of JSON (challenge page)` : `[${status}] non-JSON response`,
    );
  }
  const obj = isRecord(json) ? json : null;
  const data = obj?.["data"];
  const errors = obj?.["errors"];
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const errorMessage = (fallback: string): string =>
    typeof first === "object" &&
    first !== null &&
    "message" in first &&
    typeof first.message === "string"
      ? first.message
      : fallback;
  if (data == null) return fail("graphql_error", errorMessage("no data"));
  if (
    res.rootField !== undefined &&
    first !== undefined &&
    (!isRecord(data) || data[res.rootField] == null)
  ) {
    // {data: {root: null}, errors: [...]}: the resolver failed (an incident),
    // which says nothing about the session.
    return fail("graphql_error", errorMessage(`no ${res.rootField}`));
  }
  return { ok: true, data };
}
