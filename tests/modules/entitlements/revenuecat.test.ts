import { describe, expect, test } from "bun:test";
import {
  createRevenueCatClient,
  parseRetryAfterMs,
  RevenueCatError,
  REVENUECAT_TIMEOUT_MS,
} from "../../../src/modules/entitlements/revenuecat";
import {
  RC_API_KEY,
  RC_PROJECT,
  rcCustomer,
  rcCustomerUrl,
} from "../../helpers/entitlements-registration";
import { fakeFetch, rejection } from "../../helpers";

function setup() {
  const fetch = fakeFetch();
  const client = createRevenueCatClient({ fetch, projectId: RC_PROJECT, apiKey: RC_API_KEY });
  return { fetch, client };
}

async function failureKind(promise: Promise<unknown>): Promise<string> {
  const err = await rejection(promise);
  expect(err).toBeInstanceOf(RevenueCatError);
  return (err as RevenueCatError).kind;
}

describe("RevenueCat client", () => {
  test("active Pro entitlement with an expiry", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("cust1"), rcCustomer([{ expires_at: 1_900_000_000_000 }]));
    expect(await client.getProEntitlement("cust1")).toEqual({
      found: true,
      isPro: true,
      expiresAt: 1_900_000_000_000,
    });
    const call = fetch.calls[0]!;
    expect(call.url).toBe(`https://api.revenuecat.com/v2/projects/${RC_PROJECT}/customers/cust1`);
    expect(call.method).toBe("GET");
    expect(call.headers.get("authorization")).toBe(`Bearer ${RC_API_KEY}`);
    expect(call.init.timeoutMs).toBe(REVENUECAT_TIMEOUT_MS);
    expect(REVENUECAT_TIMEOUT_MS).toBe(8_000);
  });

  test("lifetime entitlement (expires_at null) means no expiry", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), rcCustomer([{ expires_at: null }]));
    expect(await client.getProEntitlement("c")).toEqual({
      found: true,
      isPro: true,
      expiresAt: null,
    });
  });

  test("only other entitlements: found but not Pro", async () => {
    const { fetch, client } = setup();
    fetch.on(
      "GET",
      rcCustomerUrl("c"),
      rcCustomer([{ entitlement_id: "entlother", expires_at: null }]),
    );
    expect(await client.getProEntitlement("c")).toEqual({
      found: true,
      isPro: false,
      expiresAt: null,
    });
  });

  test("404 means the customer is unknown there (not Pro)", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), { status: 404, json: { type: "resource_missing" } });
    expect(await client.getProEntitlement("c")).toEqual({ found: false });
  });

  test("encodes every path segment", async () => {
    const fetch = fakeFetch().enqueue({ status: 404 }).enqueue({ status: 404 });
    const client = createRevenueCatClient({ fetch, projectId: "p/../x", apiKey: "k" });
    await client.getProEntitlement("$RCAnonymousID:abc");
    await client.getProEntitlement("a/../../b?c#d");
    expect(fetch.calls[0]!.url).toBe(
      "https://api.revenuecat.com/v2/projects/p%2F..%2Fx/customers/%24RCAnonymousID%3Aabc",
    );
    expect(fetch.calls[1]!.url).toBe(
      "https://api.revenuecat.com/v2/projects/p%2F..%2Fx/customers/a%2F..%2F..%2Fb%3Fc%23d",
    );
  });

  test("429 → rate_limited", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), { status: 429, headers: { "Retry-After": "3" } });
    expect(await failureKind(client.getProEntitlement("c"))).toBe("rate_limited");
  });

  test("429 carries the wait hint: Retry-After seconds, else the body's backoff_ms", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("h"), { status: 429, headers: { "Retry-After": "3" } });
    fetch.on("GET", rcCustomerUrl("b"), {
      status: 429,
      json: { type: "rate_limit_error", message: "slow down", backoff_ms: 1500 },
    });
    fetch.on("GET", rcCustomerUrl("n"), { status: 429, body: "nope" });
    const hint = async (id: string) =>
      ((await rejection(client.getProEntitlement(id))) as RevenueCatError).retryAfterMs;
    expect(await hint("h")).toBe(3000);
    expect(await hint("b")).toBe(1500);
    expect(await hint("n")).toBeUndefined();
    // An HTTP-date or junk header is ignored, falling back to the body.
    expect(
      parseRetryAfterMs(
        new Headers({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }),
        '{"backoff_ms":250}',
      ),
    ).toBe(250);
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "-5" }), "")).toBeUndefined();
  });

  test("5xx → server", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), { status: 503, body: "down" });
    expect(await failureKind(client.getProEntitlement("c"))).toBe("server");
  });

  test("other 4xx (bad API key) → http", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), { status: 401, json: { type: "authentication_error" } });
    const err = await rejection(client.getProEntitlement("c"));
    expect((err as RevenueCatError).kind).toBe("http");
    expect((err as RevenueCatError).status).toBe(401);
  });

  test("timeout → timeout", async () => {
    const { fetch, client } = setup();
    fetch.on(
      "GET",
      rcCustomerUrl("c"),
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    );
    expect(await failureKind(client.getProEntitlement("c"))).toBe("timeout");
  });

  test("connection error → network", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), new TypeError("connection refused"));
    expect(await failureKind(client.getProEntitlement("c"))).toBe("network");
  });

  test("non-JSON body → parse", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), { body: "<html>oops</html>" });
    expect(await failureKind(client.getProEntitlement("c"))).toBe("parse");
  });

  test("unexpected JSON shape → parse", async () => {
    const { fetch, client } = setup();
    fetch.on("GET", rcCustomerUrl("c"), {
      json: { object: "customer", active_entitlements: null },
    });
    expect(await failureKind(client.getProEntitlement("c"))).toBe("parse");
  });
});
