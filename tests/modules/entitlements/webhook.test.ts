import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { customers } from "../../../src/db/schema";
import { buildApp } from "../../../src/http/app";
import {
  createEntitlementService,
  createEntitlementsModule,
  type EntitlementServiceImpl,
  WEBHOOK_PATH,
} from "../../../src/modules/entitlements";
import { isAuthorized } from "../../../src/modules/entitlements/webhook";
import type { App } from "../../../src/types";
import {
  appPost,
  deferred,
  OFFICIAL_ENV,
  OFFICIAL_WEBHOOK_ENV,
  rcCustomer,
  rcCustomerUrl,
  WEBHOOK_SECRET,
} from "../../helpers/entitlements-registration";
import { type TestDeps, testDeps } from "../../helpers";

let deps: TestDeps;
let cleanup: (() => void) | undefined;
let service: EntitlementServiceImpl;
let app: App;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function setup(env: Record<string, string> = OFFICIAL_WEBHOOK_ENV) {
  deps = await testDeps({ env });
  cleanup = deps.cleanup;
  service = createEntitlementService(deps);
  app = buildApp(deps, [createEntitlementsModule(service)]);
}

function seed(customerId: string, isPro = false) {
  const now = deps.clock.now();
  deps.db.insert(customers).values({ customerId, isPro, createdAt: now, updatedAt: now }).run();
}

const isPro = (id: string) =>
  deps.db.select().from(customers).where(eq(customers.customerId, id)).get()?.isPro;

/** A RevenueCat-shaped event (fields from the webhook event reference). */
function event(fields: Record<string, unknown>) {
  return {
    api_version: "1.0",
    event: {
      id: "evt-1",
      type: "INITIAL_PURCHASE",
      event_timestamp_ms: 1_700_000_000_000,
      entitlement_ids: ["entla7f4253fb6"],
      ...fields,
    },
  };
}

describe("isAuthorized", () => {
  test("accepts the bare secret and 'Bearer <secret>' only", () => {
    expect(isAuthorized("s3cret", "s3cret")).toBe(true);
    expect(isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorized(undefined, "s3cret")).toBe(false);
    expect(isAuthorized("", "s3cret")).toBe(false);
    expect(isAuthorized("s3cre", "s3cret")).toBe(false);
    expect(isAuthorized("Bearer s3cretX", "s3cret")).toBe(false);
    expect(isAuthorized("Basic s3cret", "s3cret")).toBe(false);
  });
});

describe("POST /api/webhooks/revenuecat", () => {
  test("not mounted without REVENUECAT_WEBHOOK_SECRET (JSON 404)", async () => {
    await setup(OFFICIAL_ENV);
    const res = await app.fetch(appPost(WEBHOOK_PATH, event({ app_user_id: "a" })));
    expect(res.status).toBe(404);
  });

  test("401 without or with a wrong Authorization header; nothing refreshed", async () => {
    await setup();
    seed("a");
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: "wrong" },
      { Authorization: `Bearer x${WEBHOOK_SECRET}` },
    ];
    for (const headers of attempts) {
      const res = await app.fetch(appPost(WEBHOOK_PATH, event({ app_user_id: "a" }), headers));
      expect(res.status).toBe(401);
    }
    await service.settled();
    expect(deps.fetch.calls).toHaveLength(0);
  });

  test("bare secret and Bearer form both work", async () => {
    await setup();
    for (const auth of [WEBHOOK_SECRET, `Bearer ${WEBHOOK_SECRET}`]) {
      const res = await app.fetch(
        appPost(WEBHOOK_PATH, event({ app_user_id: "nobody" }), { Authorization: auth }),
      );
      expect(res.status).toBe(200);
    }
  });

  test("refreshes every known id among app_user_id, original_app_user_id and aliases", async () => {
    await setup();
    seed("alias-known");
    seed("original-known");
    deps.fetch.on("GET", /customers\//, rcCustomer([{ expires_at: null }]));
    const res = await app.fetch(
      appPost(
        WEBHOOK_PATH,
        event({
          app_user_id: "current-unknown",
          original_app_user_id: "original-known",
          aliases: ["original-known", "alias-known", "alias-unknown", 42, "bad/id"],
        }),
        { Authorization: WEBHOOK_SECRET },
      ),
    );
    expect(res.status).toBe(200);
    await service.settled();
    const asked = deps.fetch.calls.map((c) => c.url).sort();
    expect(asked).toEqual([rcCustomerUrl("alias-known"), rcCustomerUrl("original-known")]);
    expect(isPro("alias-known")).toBe(true);
    expect(isPro("original-known")).toBe(true);
    // Unknown ids never create rows.
    expect(isPro("current-unknown")).toBeUndefined();
    expect(isPro("alias-unknown")).toBeUndefined();
  });

  test("ignores the stored check age (maxAge 0)", async () => {
    await setup();
    const now = deps.clock.now();
    deps.db
      .insert(customers)
      .values({
        customerId: "a",
        isPro: true,
        entitlementCheckedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    deps.fetch.on("GET", rcCustomerUrl("a"), { status: 404 });
    await app.fetch(
      appPost(WEBHOOK_PATH, event({ type: "EXPIRATION", app_user_id: "a" }), {
        Authorization: WEBHOOK_SECRET,
      }),
    );
    await service.settled();
    expect(isPro("a")).toBe(false);
  });

  test("TRANSFER events: transferred_from and transferred_to", async () => {
    await setup();
    seed("from");
    seed("to");
    deps.fetch.on("GET", rcCustomerUrl("from"), { status: 404 });
    deps.fetch.on("GET", rcCustomerUrl("to"), rcCustomer([{ expires_at: null }]));
    await app.fetch(
      appPost(
        WEBHOOK_PATH,
        { event: { type: "TRANSFER", transferred_from: ["from"], transferred_to: ["to"] } },
        { Authorization: WEBHOOK_SECRET },
      ),
    );
    await service.settled();
    expect(deps.fetch.calls).toHaveLength(2);
    expect(isPro("to")).toBe(true);
  });

  test("answers 200 before RevenueCat does", async () => {
    await setup();
    seed("a");
    const gate = deferred();
    deps.fetch.on("GET", rcCustomerUrl("a"), async () => {
      await gate.promise;
      return rcCustomer([{ expires_at: null }]);
    });
    const res = await app.fetch(
      appPost(WEBHOOK_PATH, event({ app_user_id: "a" }), { Authorization: WEBHOOK_SECRET }),
    );
    expect(res.status).toBe(200);
    expect(isPro("a")).toBe(false);
    gate.resolve();
    await service.settled();
    expect(isPro("a")).toBe(true);
  });

  test("upstream failure in the background is captured (logged), never thrown", async () => {
    await setup();
    seed("a", true);
    deps.fetch.on("GET", rcCustomerUrl("a"), { status: 502 });
    const res = await app.fetch(
      appPost(WEBHOOK_PATH, event({ app_user_id: "a" }), { Authorization: WEBHOOK_SECRET }),
    );
    expect(res.status).toBe(200);
    await service.settled();
    expect(isPro("a")).toBe(true);
    expect(deps.metrics.get("entitlements.refresh.failed.server")).toBe(1);
    // One transient failure is not paged (alerts go by failure rate).
    expect(deps.alerter.alerts).toEqual([]);
  });

  test("an unfamiliar event shape still gets 200; invalid JSON gets 400", async () => {
    await setup();
    const odd = await app.fetch(
      appPost(
        WEBHOOK_PATH,
        { event: { type: "SOMETHING_NEW" } },
        { Authorization: WEBHOOK_SECRET },
      ),
    );
    expect(odd.status).toBe(200);
    const bad = await app.fetch(appPost(WEBHOOK_PATH, "{nope", { Authorization: WEBHOOK_SECRET }));
    expect(bad.status).toBe(400);
  });
});
