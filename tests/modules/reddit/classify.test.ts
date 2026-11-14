import { describe, expect, test } from "bun:test";
import type { RedditErrorKind } from "../../../src/modules/contracts";
import {
  classifyHomeFailure,
  classifyMissingToken,
  classifyQueryResponse,
  looksLikePage,
  proxyVerdict,
  type QueryResponse,
} from "../../../src/modules/reddit/classify";

const HTML = "<!DOCTYPE html><html><body>blocked</body></html>";
const q = (overrides: Partial<QueryResponse>): QueryResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ data: { ok: true } }),
  tokenFresh: false,
  ...overrides,
});
const kindOf = (res: QueryResponse): RedditErrorKind | "ok" => {
  const outcome = classifyQueryResponse(res);
  return outcome.ok ? "ok" : outcome.kind;
};

describe("classifyQueryResponse", () => {
  test("200 with data is ok", () => {
    const outcome = classifyQueryResponse(q({}));
    expect(outcome).toEqual({ ok: true, data: { ok: true } });
  });

  test("401 is auth, fresh token or not", () => {
    expect(kindOf(q({ status: 401, body: "" }))).toBe("auth");
    expect(kindOf(q({ status: 401, body: "", tokenFresh: true }))).toBe("auth");
  });

  test("403 on an older token is auth, even with HTML", () => {
    expect(kindOf(q({ status: 403, body: "{}" }))).toBe("auth");
    expect(kindOf(q({ status: 403, body: HTML, contentType: "text/html" }))).toBe("auth");
  });

  test("403 HTML on a fresh token is edge_block", () => {
    expect(
      kindOf(
        q({ status: 403, body: HTML, contentType: "text/html; charset=utf-8", tokenFresh: true }),
      ),
    ).toBe("edge_block");
    // No content type, but markup.
    expect(kindOf(q({ status: 403, body: `  ${HTML}`, contentType: null, tokenFresh: true }))).toBe(
      "edge_block",
    );
  });

  test("403 captcha on a fresh token is edge_block", () => {
    expect(
      kindOf(q({ status: 403, body: '{"reason":"captcha required"}', tokenFresh: true })),
    ).toBe("edge_block");
  });

  test("403 JSON on a fresh token is auth", () => {
    expect(kindOf(q({ status: 403, body: '{"message":"Forbidden"}', tokenFresh: true }))).toBe(
      "auth",
    );
  });

  test("429 is rate_limited", () => {
    expect(kindOf(q({ status: 429, body: "" }))).toBe("rate_limited");
  });

  test("5xx is server", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(kindOf(q({ status, body: HTML, contentType: "text/html" }))).toBe("server");
    }
  });

  test("other 4xx: HTML is edge_block, otherwise graphql_error", () => {
    expect(kindOf(q({ status: 400, body: '{"errors":[]}' }))).toBe("graphql_error");
    expect(kindOf(q({ status: 404, body: HTML, contentType: "text/html" }))).toBe("edge_block");
  });

  test("200 that isn't JSON is edge_block (challenge page)", () => {
    const outcome = classifyQueryResponse(q({ body: HTML, contentType: "text/html" }));
    expect(outcome).toEqual({
      ok: false,
      kind: "edge_block",
      message: "[200] HTML instead of JSON (challenge page)",
    });
    expect(kindOf(q({ body: "not json" }))).toBe("edge_block");
  });

  test("200 with errors and no data is graphql_error with the first message", () => {
    const outcome = classifyQueryResponse(
      q({ body: JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] }) }),
    );
    expect(outcome).toEqual({
      ok: false,
      kind: "graphql_error",
      message: "PersistedQueryNotFound",
    });
    expect(classifyQueryResponse(q({ body: '{"data":null}' }))).toEqual({
      ok: false,
      kind: "graphql_error",
      message: "no data",
    });
    expect(kindOf(q({ body: "null" }))).toBe("graphql_error");
    expect(kindOf(q({ body: "[1,2]" }))).toBe("graphql_error");
  });
});

describe("handshake classification", () => {
  test("home page failure without the session either", () => {
    expect(classifyHomeFailure(429)).toBe("rate_limited");
    expect(classifyHomeFailure(503)).toBe("server");
    expect(classifyHomeFailure(403)).toBe("edge_block");
    expect(classifyHomeFailure(404)).toBe("edge_block");
  });

  test("no token_v2 issued", () => {
    expect(classifyMissingToken(400)).toBe("session_dead");
    expect(classifyMissingToken(200)).toBe("session_dead");
    expect(classifyMissingToken(403)).toBe("session_dead");
    expect(classifyMissingToken(403, "application/json")).toBe("session_dead");
    expect(classifyMissingToken(429)).toBe("rate_limited");
    expect(classifyMissingToken(500)).toBe("server");
  });

  // A 403 edge page on the token POST is the proxy being blocked, not Reddit's
  // answer about the session: it must not count toward needs_reauth.
  test("no token_v2 with a 403 web page: edge_block", () => {
    expect(classifyMissingToken(403, "text/html; charset=utf-8")).toBe("edge_block");
  });
});

const withRoot = (body: unknown): QueryResponse =>
  q({ body: JSON.stringify(body), rootField: "notificationInboxV2" });

describe("partial GraphQL failures", () => {
  // During an incident Reddit can answer {data: {root: null}, errors: [...]}.
  // That is a resolver failure, not a dead session (whose response has no errors).
  test("root field null with errors: graphql_error", () => {
    const outcome = classifyQueryResponse(
      withRoot({ data: { notificationInboxV2: null }, errors: [{ message: "upstream timeout" }] }),
    );
    expect(outcome).toEqual({ ok: false, kind: "graphql_error", message: "upstream timeout" });
  });

  test("root field null without errors is passed on (the parser calls it session_dead)", () => {
    expect(kindOf(withRoot({ data: { notificationInboxV2: null } }))).toBe("ok");
  });

  test("errors next to a present root field don't fail the query", () => {
    expect(
      kindOf(withRoot({ data: { notificationInboxV2: {} }, errors: [{ message: "minor" }] })),
    ).toBe("ok");
  });
});

describe("proxyVerdict", () => {
  test("network, edge_block and rate_limited blame the proxy; 5xx doesn't", () => {
    expect(proxyVerdict("network")).toBe("failure");
    expect(proxyVerdict("edge_block")).toBe("failure");
    expect(proxyVerdict("rate_limited")).toBe("failure");
    expect(proxyVerdict("server")).toBe("neutral");
    expect(proxyVerdict("no_proxy")).toBe("neutral");
    expect(proxyVerdict("auth")).toBe("success");
    expect(proxyVerdict("session_dead")).toBe("success");
    expect(proxyVerdict("graphql_error")).toBe("success");
  });
});

describe("looksLikePage", () => {
  test("content type, leading markup or a captcha", () => {
    expect(looksLikePage("text/html", "")).toBe(true);
    expect(looksLikePage(null, "\n<html>")).toBe(true);
    expect(looksLikePage("application/json", '{"captcha":1}')).toBe(true);
    expect(looksLikePage("application/json", '{"data":{}}')).toBe(false);
  });
});
