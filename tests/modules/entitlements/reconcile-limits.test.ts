import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { customers, type CustomerRow } from "../../../src/db/schema";
import { JobRunner } from "../../../src/lib/jobs";
import {
  createEntitlementService,
  createEntitlementsModule,
  RECONCILE_JOB,
} from "../../../src/modules/entitlements";
import {
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
} from "../../../src/modules/entitlements/service";
import {
  deferred,
  OFFICIAL_ENV,
  rcCustomer,
  rcCustomerUrl,
} from "../../helpers/entitlements-registration";
import { type TestDeps, testDeps } from "../../helpers";

let deps: TestDeps;
afterEach(() => deps.cleanup());

async function official() {
  deps = await testDeps({ env: OFFICIAL_ENV });
  return createEntitlementService(deps);
}

function seedPro(n: number): string[] {
  const now = deps.clock.now();
  const ids = Array.from({ length: n }, (_, i) => `pro${String(i).padStart(3, "0")}`);
  for (const customerId of ids) {
    deps.db
      .insert(customers)
      .values({ customerId, createdAt: now, updatedAt: now, isPro: true })
      .run();
  }
  return ids;
}

function row(customerId: string): CustomerRow | undefined {
  return deps.db.select().from(customers).where(eq(customers.customerId, customerId)).get();
}

function checkedCount(ids: string[]): number {
  return ids.filter((id) => row(id)?.entitlementCheckedAt != null).length;
}

/** Lets queued microtasks and timers run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("reconcile stops at shutdown", () => {
  test("module stop() halts the queue: only the calls already in flight finish", async () => {
    const service = await official();
    const ids = seedPro(20);
    const gate = deferred();
    deps.fetch.on("GET", /customers\//, async () => {
      await gate.promise;
      return rcCustomer([{ expires_at: null }]);
    });
    const mod = createEntitlementsModule(service);
    const running = service.reconcile();
    await tick();
    expect(deps.fetch.calls).toHaveLength(2);

    const stopped = mod.stop?.();
    gate.resolve();
    await stopped;
    const result = await running;

    expect(deps.fetch.calls).toHaveLength(2);
    expect(result).toEqual({ checked: 2, failed: 0, skipped: 18 });
    expect(checkedCount(ids)).toBe(2);
    // Skipped customers are not failures: no reconcile alert.
    expect(deps.alerter.alerts).toHaveLength(0);
    expect(deps.metrics.get("entitlements.reconcile.skipped")).toBe(18);
    expect(
      deps.log.lines.some(
        (l) =>
          l["msg"]?.toString().startsWith("entitlements reconcile stopped early") &&
          l["reason"] === "stopping",
      ),
    ).toBe(true);
  });

  test("a reconcile after stop() asks nobody", async () => {
    const service = await official();
    seedPro(3);
    deps.fetch.on("GET", /customers\//, rcCustomer([{ expires_at: null }]));
    await service.stop();
    expect(await service.reconcile()).toEqual({ checked: 0, failed: 0, skipped: 3 });
    expect(deps.fetch.calls).toHaveLength(0);
  });

  test("the job's signal halts the run as well", async () => {
    const service = await official();
    seedPro(10);
    const gate = deferred();
    deps.fetch.on("GET", /customers\//, async () => {
      await gate.promise;
      return { status: 404 };
    });
    const controller = new AbortController();
    const running = service.reconcile({ signal: controller.signal });
    await tick();
    controller.abort();
    gate.resolve();
    expect(await running).toEqual({ checked: 2, failed: 0, skipped: 8 });
    expect(deps.fetch.calls).toHaveLength(2);
  });

  test("through the real JobRunner: stopAll then module stop() makes no further calls", async () => {
    const service = await official();
    const ids = seedPro(100);
    deps.fetch.on("GET", /customers\//, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return rcCustomer([{ expires_at: null }]);
    });
    const runner = new JobRunner({ log: deps.log, alerter: deps.alerter, clock: deps.clock });
    const mod = createEntitlementsModule(service);
    mod.jobs?.(runner);
    const job = runner.runNow(RECONCILE_JOB);
    await new Promise((r) => setTimeout(r, 50));
    await runner.stopAll(10);
    const callsAtStop = deps.fetch.calls.length;

    const started = performance.now();
    await mod.stop?.();
    const elapsed = performance.now() - started;
    await job;

    // At most the RECONCILE_CONCURRENCY calls that were in flight finish.
    expect(deps.fetch.calls.length).toBeLessThanOrEqual(callsAtStop + 2);
    expect(deps.fetch.calls.length).toBeLessThan(ids.length);
    expect(elapsed).toBeLessThan(500);
    expect(runner.heartbeats()[RECONCILE_JOB]?.failures).toBe(0);
  });
});

describe("reconcile and RevenueCat rate limits", () => {
  test("a 429 stops the batch; the rest stay due and no call is made while backing off", async () => {
    const service = await official();
    const ids = seedPro(200);
    deps.fetch.on("GET", /customers\//, { status: 429, headers: { "Retry-After": "60" } });

    const result = await service.reconcile();
    // Only the two calls already running when the first 429 came back.
    expect(deps.fetch.calls).toHaveLength(2);
    expect(result).toEqual({ checked: 2, failed: 2, skipped: 198 });
    expect(checkedCount(ids)).toBe(0);
    expect(
      deps.log.lines.some(
        (l) =>
          l["msg"]?.toString().startsWith("entitlements reconcile stopped early") &&
          l["reason"] === "rate_limited",
      ),
    ).toBe(true);
    expect(deps.alerter.alerts.map((a) => a.key)).toContain("revenuecat:rate_limited");

    // Still within Retry-After: neither reconcile nor request-path refreshes call.
    deps.clock.advance(59_000);
    expect(await service.reconcile()).toEqual({ checked: 0, failed: 0, skipped: 200 });
    await service.refreshIfStale(ids[0]!, 0);
    expect(deps.fetch.calls).toHaveLength(2);
    expect(deps.metrics.get("entitlements.refresh.backoff")).toBe(1);
    expect(row(ids[0]!)).toMatchObject({ isPro: true, entitlementCheckedAt: null });

    // After it, calls resume and the remaining customers are picked up.
    deps.clock.advance(1_000);
    deps.fetch.on("GET", /customers\//, rcCustomer([{ expires_at: null }]));
    expect(await service.reconcile()).toEqual({ checked: 200, failed: 0, skipped: 0 });
    expect(checkedCount(ids)).toBe(200);
  });

  test("a 429 mid-batch: at most the calls already in flight still go out", async () => {
    const service = await official();
    const ids = seedPro(30);
    deps.fetch.on("GET", /customers\//, rcCustomer([{ expires_at: null }]));
    deps.fetch.on("GET", rcCustomerUrl(ids[4]!), { status: 429 });
    const result = await service.reconcile();
    // ids[0..4] plus at most one more that the limiter had already started.
    expect(deps.fetch.calls.length).toBeGreaterThanOrEqual(5);
    expect(deps.fetch.calls.length).toBeLessThanOrEqual(6);
    expect(result.failed).toBe(1);
    expect(result.checked).toBe(deps.fetch.calls.length);
    expect(result.skipped).toBe(30 - deps.fetch.calls.length);
  });

  test("backoff length: Retry-After, else the default, clamped to an hour", async () => {
    const service = await official();
    deps.fetch.on("GET", rcCustomerUrl("a"), { status: 429 });
    await service.refreshIfStale("a", 0);
    deps.fetch.on("GET", rcCustomerUrl("a"), rcCustomer([{ expires_at: null }]));
    deps.clock.advance(DEFAULT_RATE_LIMIT_BACKOFF_MS - 1);
    await service.refreshIfStale("a", 0);
    expect(deps.fetch.calls).toHaveLength(1);
    deps.clock.advance(1);
    await service.refreshIfStale("a", 0);
    expect(deps.fetch.calls).toHaveLength(2);
    expect(row("a")?.isPro).toBe(true);

    deps.fetch.on("GET", rcCustomerUrl("b"), {
      status: 429,
      headers: { "Retry-After": String(24 * 60 * 60) },
    });
    await service.refreshIfStale("b", 0);
    deps.fetch.on("GET", rcCustomerUrl("b"), rcCustomer([{ expires_at: null }]));
    deps.clock.advance(MAX_RATE_LIMIT_BACKOFF_MS);
    await service.refreshIfStale("b", 0);
    expect(row("b")?.isPro).toBe(true);
  });
});
