import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { customers, type CustomerRow } from "../../../src/db/schema";
import { type AppError, BadRequest, Forbidden } from "../../../src/lib/errors";
import { JobRunner } from "../../../src/lib/jobs";
import {
  createEntitlementService,
  createEntitlementsModule,
  RECONCILE_INTERVAL_MS,
  RECONCILE_INTERVAL_NO_WEBHOOK_MS,
  RECONCILE_JOB,
} from "../../../src/modules/entitlements";
import { DEFAULT_MAX_AGE_MS } from "../../../src/modules/entitlements/service";
import {
  deferred,
  OFFICIAL_ENV,
  OFFICIAL_WEBHOOK_ENV,
  rcCustomer,
  rcCustomerUrl,
} from "../../helpers/entitlements-registration";
import { type TestDeps, testDeps } from "../../helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let deps: TestDeps;
afterEach(() => deps.cleanup());

async function official(env: Record<string, string> = OFFICIAL_ENV) {
  deps = await testDeps({ env });
  return createEntitlementService(deps);
}

function seed(
  customerId: string,
  fields: Partial<typeof customers.$inferInsert> = {},
): CustomerRow {
  const now = deps.clock.now();
  return deps.db
    .insert(customers)
    .values({ customerId, createdAt: now, updatedAt: now, ...fields })
    .returning()
    .get();
}

function row(customerId: string): CustomerRow | undefined {
  return deps.db.select().from(customers).where(eq(customers.customerId, customerId)).get();
}

describe("isEntitled", () => {
  test("official: is_pro with no expiry, a future expiry, or a past one", async () => {
    const service = await official();
    const now = deps.clock.now();
    const base = seed("c1");
    expect(service.isEntitled({ ...base, isPro: false }, now)).toBe(false);
    expect(service.isEntitled({ ...base, isPro: false, proExpiresAt: now + HOUR }, now)).toBe(
      false,
    );
    expect(service.isEntitled({ ...base, isPro: true, proExpiresAt: null }, now)).toBe(true);
    expect(service.isEntitled({ ...base, isPro: true, proExpiresAt: now + 1 }, now)).toBe(true);
    expect(service.isEntitled({ ...base, isPro: true, proExpiresAt: now }, now)).toBe(false);
    expect(service.isEntitled({ ...base, isPro: true, proExpiresAt: now - HOUR }, now)).toBe(false);
  });

  test("selfhost: always entitled", async () => {
    deps = await testDeps();
    const service = createEntitlementService(deps);
    const base = seed("c1");
    expect(service.isEntitled({ ...base, isPro: false }, deps.clock.now())).toBe(true);
  });
});

describe("ensureCustomer / requirePro", () => {
  test("ensureCustomer upserts and is idempotent; rejects invalid ids", async () => {
    const service = await official();
    const a = service.ensureCustomer("$RCAnonymousID:abc");
    const b = service.ensureCustomer("$RCAnonymousID:abc");
    expect(a.id).toBe(b.id);
    expect(a.isPro).toBe(false);
    expect(() => service.ensureCustomer("bad/id")).toThrow(BadRequest);
    expect(() => service.ensureCustomer("")).toThrow(BadRequest);
  });

  test("requirePro: 403 text 'Customer is not subscribed' (v1 middleware/subscription.ts)", async () => {
    const service = await official();
    seed("free");
    seed("pro", { isPro: true });
    seed("expired", { isPro: true, proExpiresAt: deps.clock.now() - 1 });
    expect(service.requirePro("pro").customerId).toBe("pro");
    for (const id of ["free", "expired", "unknown"]) {
      let thrown: unknown;
      try {
        service.requirePro(id);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Forbidden);
      const err = thrown as AppError;
      expect(err.status).toBe(403);
      expect(err.message).toBe("Customer is not subscribed");
    }
    // It decides from the DB alone; only the expired Pro row starts a background check.
    await service.settled();
    expect(deps.fetch.calls.map((c) => c.url)).toEqual([rcCustomerUrl("expired")]);
  });

  // Without the webhook, a renewal used to stay locked out (403) until the
  // next hourly reconcile, although RevenueCat already had it.
  test("requirePro: an expired Pro row is rechecked in the background, at most once a minute", async () => {
    const service = await official();
    seed("renewed", { isPro: true, proExpiresAt: deps.clock.now() - 1, entitlementCheckedAt: 0 });
    deps.fetch.on(
      "GET",
      rcCustomerUrl("renewed"),
      rcCustomer([{ expires_at: deps.clock.now() + 30 * DAY }]),
    );
    expect(() => service.requirePro("renewed")).toThrow(Forbidden);
    await service.settled();
    expect(service.requirePro("renewed").customerId).toBe("renewed");
    expect(deps.fetch.calls).toHaveLength(1);

    // A lapsed one keeps getting 403, without a RevenueCat call per request.
    seed("lapsed", { isPro: true, proExpiresAt: deps.clock.now() - 1, entitlementCheckedAt: 0 });
    deps.fetch.on("GET", rcCustomerUrl("lapsed"), { status: 404 });
    for (let i = 0; i < 5; i++) {
      expect(() => service.requirePro("lapsed")).toThrow(Forbidden);
      await service.settled();
    }
    expect(deps.fetch.calls).toHaveLength(2);
  });

  test("requirePro in selfhost passes everyone (v1 IS_CUSTOM_SERVER)", async () => {
    deps = await testDeps();
    const service = createEntitlementService(deps);
    expect(service.requirePro("anyone").customerId).toBe("anyone");
  });
});

describe("refreshIfStale", () => {
  test("stores the RevenueCat result and skips while fresh", async () => {
    const service = await official();
    const expires = deps.clock.now() + 30 * 24 * HOUR;
    deps.fetch.on("GET", rcCustomerUrl("c1"), rcCustomer([{ expires_at: expires }]));
    await service.refreshIfStale("c1");
    expect(row("c1")).toMatchObject({
      isPro: true,
      proExpiresAt: expires,
      entitlementSource: "revenuecat",
      entitlementCheckedAt: deps.clock.now(),
    });
    deps.clock.advance(DEFAULT_MAX_AGE_MS - 1);
    await service.refreshIfStale("c1");
    expect(deps.fetch.calls).toHaveLength(1);
    deps.clock.advance(1);
    await service.refreshIfStale("c1");
    expect(deps.fetch.calls).toHaveLength(2);
    // maxAge 0 always calls.
    await service.refreshIfStale("c1", 0);
    expect(deps.fetch.calls).toHaveLength(3);
  });

  test("404 clears Pro", async () => {
    const service = await official();
    seed("c1", { isPro: true, proExpiresAt: null, entitlementSource: "legacy_import" });
    deps.fetch.on("GET", rcCustomerUrl("c1"), { status: 404 });
    await service.refreshIfStale("c1");
    expect(row("c1")).toMatchObject({
      isPro: false,
      proExpiresAt: null,
      entitlementSource: "revenuecat",
    });
  });

  for (const [name, responder] of [
    ["429", { status: 429 }],
    ["500", { status: 500 }],
    ["timeout", Object.assign(new Error("t"), { name: "TimeoutError" })],
    ["bad JSON", { body: "not json" }],
  ] as const) {
    test(`${name} keeps the last known state and logs`, async () => {
      const service = await official();
      seed("c1", { isPro: true, proExpiresAt: null, entitlementCheckedAt: null });
      deps.fetch.on("GET", rcCustomerUrl("c1"), responder);
      await service.refreshIfStale("c1");
      expect(row("c1")).toMatchObject({
        isPro: true,
        proExpiresAt: null,
        entitlementCheckedAt: null,
      });
      // A 429 alerts right away (quota exhausted, backoff starts); a single
      // transient failure doesn't page.
      expect(deps.alerter.alerts.map((a) => a.key)).toEqual(
        name === "429" ? ["revenuecat:rate_limited"] : [],
      );
      expect(
        deps.log.lines.some(
          (l) => l["msg"] === "entitlement refresh failed; keeping the last known state",
        ),
      ).toBe(true);
      expect(deps.metrics.get("entitlements.refresh.failed")).toBe(1);
    });
  }

  test("transient failures alert on a failure rate; a bad API key alerts at once", async () => {
    const service = await official();
    deps.fetch.on("GET", /customers\/ok/, rcCustomer([{ expires_at: null }]));
    deps.fetch.on("GET", /customers\/down/, { status: 503 });
    await service.refreshIfStale("ok1");
    await service.refreshIfStale("down1");
    await service.refreshIfStale("down2");
    expect(deps.alerter.alerts).toEqual([]);
    await service.refreshIfStale("down3");
    expect(deps.alerter.alerts.map((a) => a.key)).toEqual(["revenuecat:failures"]);
    expect(deps.alerter.alerts[0]!.message).toContain("3 of 4 calls failed");

    deps.fetch.on("GET", /customers\/badkey/, { status: 401 });
    await service.refreshIfStale("badkey");
    expect(deps.alerter.alerts.map((a) => a.key)).toEqual([
      "revenuecat:failures",
      "revenuecat:http",
    ]);
  });

  test("never throws, even for a customer it has never seen", async () => {
    const service = await official();
    deps.fetch.on("GET", rcCustomerUrl("new"), new TypeError("boom"));
    await service.refreshIfStale("new");
    expect(row("new")).toBeUndefined();
  });

  test("creates the row for a new customer on success", async () => {
    const service = await official();
    deps.fetch.on("GET", rcCustomerUrl("new"), rcCustomer([{ expires_at: null }]));
    await service.refreshIfStale("new");
    expect(row("new")).toMatchObject({ isPro: true, proExpiresAt: null });
  });

  test("single-flight per customer", async () => {
    const service = await official();
    const gate = deferred();
    deps.fetch.on("GET", rcCustomerUrl("c1"), async () => {
      await gate.promise;
      return rcCustomer([{ expires_at: null }]);
    });
    const a = service.refreshIfStale("c1");
    const b = service.refreshIfStale("c1");
    const c = service.refreshIfStale("c1", 0);
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(deps.fetch.calls).toHaveLength(1);
  });

  test("a forced refresh that arrives mid-call runs once more afterwards (coalesced)", async () => {
    const service = await official();
    const gate = deferred();
    let n = 0;
    deps.fetch.on("GET", rcCustomerUrl("c1"), async () => {
      n++;
      if (n === 1) {
        await gate.promise;
        return rcCustomer([{ expires_at: null }]);
      }
      return { status: 404 };
    });
    const first = service.refreshIfStale("c1");
    deps.clock.advance(1_000);
    const forced1 = service.refreshIfStale("c1", 0);
    const forced2 = service.refreshIfStale("c1", 0);
    gate.resolve();
    await Promise.all([first, forced1, forced2]);
    expect(deps.fetch.calls).toHaveLength(2);
    // The later call's answer (404) is what's stored.
    expect(row("c1")?.isPro).toBe(false);
  });

  test("selfhost never calls RevenueCat", async () => {
    deps = await testDeps({
      env: { REVENUECAT_PROJECT_ID: "p", REVENUECAT_API_KEY: "k" },
    });
    const service = createEntitlementService(deps);
    seed("c1");
    await service.refreshIfStale("c1", 0);
    await service.reconcile();
    expect(deps.fetch.calls).toHaveLength(0);
  });

  test("invalid ids are never sent to RevenueCat", async () => {
    const service = await official();
    await service.refreshIfStale("a/b", 0);
    expect(deps.fetch.calls).toHaveLength(0);
  });
});

describe("reconcile", () => {
  test("rechecks only stale or expired Pro customers", async () => {
    const service = await official();
    const now = deps.clock.now();
    seed("never-checked", { isPro: true, entitlementCheckedAt: null });
    seed("stale", { isPro: true, entitlementCheckedAt: now - 25 * HOUR });
    seed("expired", { isPro: true, proExpiresAt: now - 1, entitlementCheckedAt: now - HOUR });
    seed("fresh", { isPro: true, proExpiresAt: now + HOUR, entitlementCheckedAt: now - HOUR });
    seed("free", { isPro: false, entitlementCheckedAt: null });
    deps.fetch.on("GET", /customers\//, { status: 404 });
    const result = await service.reconcile();
    expect(result).toEqual({ checked: 3, failed: 0, skipped: 0 });
    const asked = deps.fetch.calls.map((c) => c.url.split("/").pop() ?? "").sort();
    expect(asked).toEqual(["expired", "never-checked", "stale"]);
    expect(row("fresh")?.isPro).toBe(true);
    expect(row("stale")?.isPro).toBe(false);
  });

  test("one customer's failure never aborts the batch; failure rate alerts", async () => {
    const service = await official();
    for (const id of ["a", "b", "c", "d"]) seed(id, { isPro: true });
    deps.fetch.on("GET", /customers\//, rcCustomer([{ expires_at: null }]));
    deps.fetch.on("GET", rcCustomerUrl("b"), { status: 500 });
    deps.fetch.on("GET", rcCustomerUrl("c"), new TypeError("reset"));
    const result = await service.reconcile();
    expect(result).toEqual({ checked: 4, failed: 2, skipped: 0 });
    expect(row("a")?.entitlementCheckedAt).toBe(deps.clock.now());
    expect(row("d")?.entitlementCheckedAt).toBe(deps.clock.now());
    expect(row("b")).toMatchObject({ isPro: true, entitlementCheckedAt: null });
    expect(deps.alerter.alerts.map((a) => a.key)).toContain("entitlements-reconcile");
  });

  test("runs at most 2 RevenueCat calls at once", async () => {
    const service = await official();
    for (let i = 0; i < 6; i++) seed(`c${i}`, { isPro: true });
    let active = 0;
    let peak = 0;
    deps.fetch.on("GET", /customers\//, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return rcCustomer([{ expires_at: null }]);
    });
    expect(await service.reconcile()).toEqual({ checked: 6, failed: 0, skipped: 0 });
    expect(peak).toBe(2);
  });

  test("job: every 6 h with the webhook, hourly without, none in selfhost", async () => {
    const intervals: Record<string, number> = {};
    const fakeRunner = {
      every: (name: string, ms: number) => {
        intervals[name] = ms;
      },
    } as unknown as JobRunner;

    createEntitlementsModule(await official(OFFICIAL_WEBHOOK_ENV)).jobs?.(fakeRunner);
    expect(intervals[RECONCILE_JOB]).toBe(RECONCILE_INTERVAL_MS);
    expect(RECONCILE_INTERVAL_MS).toBe(6 * HOUR);
    deps.cleanup();

    createEntitlementsModule(await official()).jobs?.(fakeRunner);
    expect(intervals[RECONCILE_JOB]).toBe(RECONCILE_INTERVAL_NO_WEBHOOK_MS);
    expect(RECONCILE_INTERVAL_NO_WEBHOOK_MS).toBe(HOUR);
    deps.cleanup();

    delete intervals[RECONCILE_JOB];
    deps = await testDeps();
    createEntitlementsModule(createEntitlementService(deps)).jobs?.(fakeRunner);
    expect(intervals[RECONCILE_JOB]).toBeUndefined();
  });

  test("job runs through the real JobRunner", async () => {
    const service = await official();
    seed("a", { isPro: true });
    deps.fetch.on("GET", /customers\//, { status: 404 });
    const runner = new JobRunner({ log: deps.log, alerter: deps.alerter, clock: deps.clock });
    createEntitlementsModule(service).jobs?.(runner);
    expect(await runner.runNow(RECONCILE_JOB)).toBe(true);
    expect(runner.heartbeats()[RECONCILE_JOB]?.failures).toBe(0);
    expect(row("a")?.isPro).toBe(false);
  });
});
