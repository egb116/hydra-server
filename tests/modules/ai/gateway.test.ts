import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../../../src/lib/errors";
import { JobRunner } from "../../../src/lib/jobs";
import {
  AiCallError,
  buildAiRegistry,
  createAiGateway,
  createAiModule,
  normalizeUsage,
  toProviderFetch,
} from "../../../src/modules/ai";
import { monthKey, pruneCalls, startOfUtcDay } from "../../../src/modules/ai/usage";
import { rejection, type TestDeps, testDeps } from "../../helpers";
import { fakeEntitlements, PRO_CUSTOMER } from "../../helpers/ai";

let deps: TestDeps;
beforeEach(async () => {
  deps = await testDeps();
});
afterEach(() => deps.cleanup());

function gateway() {
  const { registry } = buildAiRegistry(deps.config.ai, deps.config.mode);
  return createAiGateway(deps, { entitlements: fakeEntitlements(), registry });
}

function rows(): { status: string; input_tokens: number; error: string | null }[] {
  return deps.sqlite
    .query<{ status: string; input_tokens: number; error: string | null }, []>(
      "SELECT status, input_tokens, error FROM ai_calls ORDER BY id",
    )
    .all();
}

describe("runAI", () => {
  test("records usage carried by an AiCallError and answers 502", async () => {
    const err = await rejection(
      gateway().runAI("summarizePost", { customerId: PRO_CUSTOMER }, async () => {
        throw new AiCallError("nothing", "empty", { inputTokens: 42, outputTokens: 0 });
      }),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(502);
    expect(rows()).toEqual([{ status: "empty", input_tokens: 42, error: "AiCallError: nothing" }]);
  });

  test("a programming error stays a 500 but is still recorded", async () => {
    const err = await rejection(
      gateway().runAI("summarizePost", { customerId: PRO_CUSTOMER }, async () => {
        throw new TypeError("bug");
      }),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(rows()[0]?.status).toBe("error");
  });

  test("a client disconnect is recorded as aborted", async () => {
    const controller = new AbortController();
    const err = await rejection(
      gateway().runAI(
        "answerDocs",
        { clientIp: "192.0.2.1", signal: controller.signal },
        async ({ signal }) => {
          controller.abort();
          throw signal.reason;
        },
      ),
    );
    expect((err as AppError).status).toBe(502);
    expect(rows()[0]?.status).toBe("aborted");
  });

  test("a timeout answers 502 with the timeout message", async () => {
    const err = await rejection(
      gateway().runAI("answerDocs", { clientIp: "192.0.2.1" }, async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    expect((err as AppError).message).toContain("timed out");
    expect(rows()[0]?.status).toBe("timeout");
  });

  test("the Pro gate runs before the call", async () => {
    let called = false;
    const err = await rejection(
      gateway().runAI("filterPosts", { customerId: "someone-else" }, async () => {
        called = true;
        return { value: 1 };
      }),
    );
    expect((err as AppError).status).toBe(403);
    expect(called).toBe(false);
    expect(rows()).toEqual([]);
  });
});

describe("normalizeUsage", () => {
  test("null, undefined, negative and NaN counts become 0", () => {
    expect(normalizeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(normalizeUsage({ inputTokens: null, outputTokens: Number.NaN })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(normalizeUsage({ inputTokens: -1, outputTokens: 7 })).toEqual({
      inputTokens: 0,
      outputTokens: 7,
    });
  });
});

describe("toProviderFetch", () => {
  test("adds the timeout, keeps the provider's signal, and accepts a Request", async () => {
    deps.fetch.on("*", "https://api.example.com/", { json: { ok: true } });
    const providerFetch = toProviderFetch(deps.fetch, 1_234);
    const controller = new AbortController();
    await providerFetch("https://api.example.com/v1/x", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer k" },
      signal: controller.signal,
    });
    await providerFetch(
      new Request("https://api.example.com/v1/y", { method: "POST", body: "hello" }),
    );
    const [first, second] = deps.fetch.calls;
    expect(first?.init.timeoutMs).toBe(1_234);
    expect(first?.init.signal).toBe(controller.signal);
    expect(first?.headers.get("authorization")).toBe("Bearer k");
    expect(second?.method).toBe("POST");
    expect(second?.body).toBe("hello");
    expect(second?.init.timeoutMs).toBe(1_234);
  });
});

describe("usage helpers and retention", () => {
  test("monthKey and startOfUtcDay are UTC", () => {
    const t = Date.parse("2026-11-30T23:30:00.000-05:00");
    expect(monthKey(t)).toBe("2026-12");
    expect(startOfUtcDay(t)).toBe(Date.parse("2026-12-01T00:00:00.000Z"));
  });

  test("pruneCalls deletes rows older than 90 days, and the module schedules it", async () => {
    const now = deps.clock.now();
    const day = 24 * 60 * 60 * 1000;
    for (const age of [91, 89, 0]) {
      deps.sqlite.run(
        "INSERT INTO ai_calls (ts, feature, model, latency_ms, status) VALUES (?, 'answerDocs', 'm', 1, 'ok')",
        [now - age * day],
      );
    }
    expect(pruneCalls(deps.sqlite, now)).toBe(1);
    expect(deps.sqlite.query("SELECT COUNT(*) AS n FROM ai_calls").get()).toEqual({ n: 2 });

    const names: string[] = [];
    const runner = new JobRunner({ log: deps.log, alerter: deps.alerter, clock: deps.clock });
    const original = runner.every.bind(runner);
    runner.every = (name, intervalMs, fn, options) => {
      names.push(name);
      original(name, intervalMs, fn, options);
    };
    createAiModule(deps, { entitlements: fakeEntitlements() }).jobs?.(runner);
    expect(names).toEqual(["ai.prune-calls"]);
    await runner.stopAll();
  });
});
