import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  customers,
  deviceAccounts,
  devices,
  redditAccounts,
  type RedditAccountRow,
} from "../../../src/db/schema";
import { buildApp } from "../../../src/http/app";
import { redditSecretAad, type SecretBox, secretBoxFromConfig } from "../../../src/lib/crypto";
import {
  createEntitlementService,
  type EntitlementServiceImpl,
} from "../../../src/modules/entitlements";
import {
  createRegistrationModule,
  DEVICE_EXPIRY_MS,
  MAX_ACCOUNTS,
  MAX_ACCOUNTS_PER_CUSTOMER,
  MAX_DEVICES_PER_CUSTOMER,
  MAX_PUSH_TOKEN_CHARS,
  MAX_SESSION_BYTES,
  MAX_USERNAME_CHARS,
  pruneStaleDevices,
  REGISTER_BURST,
  UNENTITLED_REFRESH_BURST,
} from "../../../src/modules/registration";
import type { App } from "../../../src/types";
import {
  appPost,
  OFFICIAL_ENV,
  rcCustomer,
  rcCustomerUrl,
} from "../../helpers/entitlements-registration";
import { TEST_KEY, type TestDeps, testDeps, v1Encrypt } from "../../helpers";

const HOUR = 60 * 60 * 1000;
let deps: TestDeps;
let entitlements: EntitlementServiceImpl;
let secretBox: SecretBox;
let app: App;
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** Selfhost by default (no RevenueCat); official mode answers 404 for everyone unless told otherwise. */
async function setup(mode: "selfhost" | "official" = "selfhost") {
  deps = await testDeps(mode === "official" ? { env: OFFICIAL_ENV } : {});
  cleanup = deps.cleanup;
  entitlements = createEntitlementService(deps);
  secretBox = secretBoxFromConfig(deps.config);
  app = buildApp(deps, [createRegistrationModule(deps, { entitlements, secretBox })]);
}

const session = (n: string) => JSON.stringify({ name: "reddit_session", value: `cookie-${n}` });

/** An Expo push token named `n` (the route only accepts Expo tokens). */
const tok = (n: string) => `ExponentPushToken[${n}]`;

async function register(
  customerId: string,
  pushToken: string,
  accounts: { username: string; session: string }[],
): Promise<Response> {
  return app.fetch(appPost("/api/notifications/register", { customerId, pushToken, accounts }));
}

async function expectSuccess(res: Response | Promise<Response>) {
  const r = await res;
  expect(await r.text()).toBe("success");
  expect(r.status).toBe(200);
}

function customerRowId(customerId: string): number {
  const row = deps.db.select().from(customers).where(eq(customers.customerId, customerId)).get();
  if (!row) throw new Error(`no customer ${customerId}`);
  return row.id;
}

function account(customerId: string, username: string): RedditAccountRow | undefined {
  return deps.db
    .select()
    .from(redditAccounts)
    .where(
      and(
        eq(redditAccounts.customerId, customerRowId(customerId)),
        eq(redditAccounts.username, username),
      ),
    )
    .get();
}

function decryptSession(customerId: string, username: string): string {
  const row = account(customerId, username);
  if (!row) throw new Error("no account");
  return secretBox.decryptSecret(row.sessionEnc, redditSecretAad(row.customerId, username));
}

/** Usernames linked to a device, sorted. Null if the device doesn't exist. */
function links(pushToken: string): string[] | null {
  const device = deps.db.select().from(devices).where(eq(devices.pushToken, pushToken)).get();
  if (!device) return null;
  return deps.db
    .select({ username: redditAccounts.username })
    .from(deviceAccounts)
    .innerJoin(redditAccounts, eq(redditAccounts.id, deviceAccounts.accountId))
    .where(eq(deviceAccounts.deviceId, device.id))
    .all()
    .map((r) => r.username)
    .sort();
}

const accountCount = () => deps.db.select().from(redditAccounts).all().length;

describe("POST /api/customers/register", () => {
  test("creates the customer, refreshes from RevenueCat, answers 'success'", async () => {
    await setup("official");
    deps.fetch.on("GET", rcCustomerUrl("$RCAnonymousID:abc"), rcCustomer([{ expires_at: null }]));
    // APP:api/Customer.ts may also send pushToken; it is ignored, as in v1.
    const res = await app.fetch(
      appPost("/api/customers/register", { customerId: "$RCAnonymousID:abc", pushToken: "x" }),
    );
    await expectSuccess(res);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    const row = entitlements.getCustomer("$RCAnonymousID:abc");
    expect(row?.isPro).toBe(true);
  });

  test("RevenueCat down: still 'success', last known state kept", async () => {
    await setup("official");
    deps.fetch.on("GET", /customers\//, { status: 503 });
    await expectSuccess(app.fetch(appPost("/api/customers/register", { customerId: "c1" })));
    expect(entitlements.getCustomer("c1")?.isPro).toBe(false);
    // One 503 is logged; alerts go by failure rate.
    expect(deps.alerter.alerts).toHaveLength(0);
  });

  test("selfhost never calls RevenueCat", async () => {
    await setup("selfhost");
    await expectSuccess(app.fetch(appPost("/api/customers/register", { customerId: "c1" })));
    expect(deps.fetch.calls).toHaveLength(0);
    expect(entitlements.getCustomer("c1")).toBeDefined();
  });

  test("invalid input is a 400 (v1 answered 500)", async () => {
    await setup();
    for (const body of [
      {},
      { customerId: "" },
      { customerId: "a/b" },
      { customerId: "a b" },
      { customerId: "x".repeat(129) },
    ]) {
      const res = await app.fetch(appPost("/api/customers/register", body));
      expect(res.status).toBe(400);
    }
    expect((await app.fetch(appPost("/api/customers/register", "{"))).status).toBe(400);
  });
});

describe("POST /api/notifications/register", () => {
  test("the app's request has no Content-Type and still works", async () => {
    await setup();
    const req = appPost("/api/notifications/register", {
      customerId: "c1",
      pushToken: "ExponentPushToken[aaa]",
      accounts: [{ username: "alice", session: session("a") }],
    });
    expect(req.headers.get("content-type")).toBeNull();
    await expectSuccess(app.fetch(req));
  });

  test("new account: v2 session with the row's AAD, baseline and next check now, linked", async () => {
    await setup();
    const now = deps.clock.now();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    const row = account("c1", "alice")!;
    expect(secretBox.isLegacy(row.sessionEnc)).toBe(false);
    expect(decryptSession("c1", "alice")).toBe(session("a"));
    expect(row).toMatchObject({
      status: "active",
      baselineAt: now,
      nextCheckAt: now,
      tokenEnc: null,
      sessionFailures: 0,
    });
    expect(links(tok("T1"))).toEqual(["alice"]);
    const device = deps.db
      .select()
      .from(devices)
      .where(eq(devices.pushToken, tok("T1")))
      .get();
    expect(device).toMatchObject({ customerId: customerRowId("c1"), lastRegisteredAt: now });
  });

  test("existing account, same session: blob and token kept, next check pulled to now", async () => {
    await setup();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    const before = account("c1", "alice")!;
    deps.db
      .update(redditAccounts)
      .set({ tokenEnc: "v2:tok", tokenExpiresAt: 123, nextCheckAt: before.nextCheckAt + HOUR })
      .where(eq(redditAccounts.id, before.id))
      .run();
    deps.clock.advance(1_000);
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    const after = account("c1", "alice")!;
    expect(after.id).toBe(before.id);
    expect(after.sessionEnc).toBe(before.sessionEnc);
    expect(after.tokenEnc).toBe("v2:tok");
    expect(after.tokenExpiresAt).toBe(123);
    expect(after.nextCheckAt).toBe(deps.clock.now());
    expect(after.baselineAt).toBe(before.baselineAt);
  });

  test("next_check_at only ever moves earlier", async () => {
    await setup();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    const early = account("c1", "alice")!.nextCheckAt;
    deps.clock.advance(HOUR);
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    expect(account("c1", "alice")!.nextCheckAt).toBe(early);
  });

  test("session change: re-encrypted, token cleared", async () => {
    await setup();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    const before = account("c1", "alice")!;
    deps.db
      .update(redditAccounts)
      .set({ tokenEnc: "v2:tok", tokenExpiresAt: 123, sessionFailures: 1 })
      .where(eq(redditAccounts.id, before.id))
      .run();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("b") }]));
    const after = account("c1", "alice")!;
    expect(decryptSession("c1", "alice")).toBe(session("b"));
    expect(after).toMatchObject({ tokenEnc: null, tokenExpiresAt: null, sessionFailures: 0 });
  });

  test("a v1 blob with the same plaintext is upgraded to v2 and keeps its token", async () => {
    await setup();
    const c = entitlements.ensureCustomer("c1");
    const now = deps.clock.now();
    const legacy = v1Encrypt(session("a"), TEST_KEY);
    deps.db
      .insert(redditAccounts)
      .values({
        customerId: c.id,
        username: "alice",
        sessionEnc: legacy,
        tokenEnc: "v2:tok",
        nextCheckAt: now,
        baselineAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    const row = account("c1", "alice")!;
    expect(secretBox.isLegacy(row.sessionEnc)).toBe(false);
    expect(decryptSession("c1", "alice")).toBe(session("a"));
    expect(row.tokenEnc).toBe("v2:tok");
  });

  test("a v1 blob with a different plaintext is replaced and the token cleared", async () => {
    await setup();
    const c = entitlements.ensureCustomer("c1");
    const now = deps.clock.now();
    deps.db
      .insert(redditAccounts)
      .values({
        customerId: c.id,
        username: "alice",
        sessionEnc: v1Encrypt(session("old"), TEST_KEY),
        tokenEnc: "v2:tok",
        nextCheckAt: now,
        baselineAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await expectSuccess(
      register("c1", tok("T1"), [{ username: "alice", session: session("new") }]),
    );
    expect(decryptSession("c1", "alice")).toBe(session("new"));
    expect(account("c1", "alice")!.tokenEnc).toBeNull();
  });

  test("needs_reauth is reset to active with session_failures 0", async () => {
    await setup();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    const id = account("c1", "alice")!.id;
    deps.db
      .update(redditAccounts)
      .set({
        status: "needs_reauth",
        sessionFailures: 2,
        nextCheckAt: deps.clock.now() + 11 * HOUR,
      })
      .where(eq(redditAccounts.id, id))
      .run();
    await expectSuccess(register("c1", tok("T1"), [{ username: "alice", session: session("a") }]));
    expect(account("c1", "alice")).toMatchObject({
      status: "active",
      sessionFailures: 0,
      nextCheckAt: deps.clock.now(),
    });
  });

  test("multi-device: device A's register never touches device B's links", async () => {
    await setup();
    await expectSuccess(
      register("c1", tok("A"), [
        { username: "u1", session: session("1") },
        { username: "u2", session: session("2") },
      ]),
    );
    await expectSuccess(
      register("c1", tok("B"), [
        { username: "u2", session: session("2") },
        { username: "u3", session: session("3") },
      ]),
    );
    expect(links(tok("A"))).toEqual(["u1", "u2"]);
    expect(links(tok("B"))).toEqual(["u2", "u3"]);

    // A drops u2: B keeps it, and the account survives because B links it.
    await expectSuccess(register("c1", tok("A"), [{ username: "u1", session: session("1") }]));
    expect(links(tok("A"))).toEqual(["u1"]);
    expect(links(tok("B"))).toEqual(["u2", "u3"]);
    expect(account("c1", "u2")).toBeDefined();

    // A drops everything: the device goes, u1 (A-only) is pruned, B is untouched.
    await expectSuccess(register("c1", tok("A"), []));
    expect(links(tok("A"))).toBeNull();
    expect(account("c1", "u1")).toBeUndefined();
    expect(links(tok("B"))).toEqual(["u2", "u3"]);
    expect(accountCount()).toBe(2);
  });

  test("an account removed from the app's only device is deleted", async () => {
    await setup();
    await expectSuccess(
      register("c1", tok("A"), [
        { username: "u1", session: session("1") },
        { username: "u2", session: session("2") },
      ]),
    );
    await expectSuccess(register("c1", tok("A"), [{ username: "u2", session: session("2") }]));
    expect(account("c1", "u1")).toBeUndefined();
    expect(links(tok("A"))).toEqual(["u2"]);
  });

  test("a push token moving to another customer takes the device with it", async () => {
    await setup();
    await expectSuccess(register("c1", tok("T"), [{ username: "old", session: session("o") }]));
    await expectSuccess(
      register("c1", tok("OTHER"), [{ username: "kept", session: session("k") }]),
    );
    await expectSuccess(register("c2", tok("T"), [{ username: "new", session: session("n") }]));
    const device = deps.db
      .select()
      .from(devices)
      .where(eq(devices.pushToken, tok("T")))
      .get()!;
    expect(device.customerId).toBe(customerRowId("c2"));
    expect(links(tok("T"))).toEqual(["new"]);
    // c1's T-only account is gone; its other device is untouched.
    expect(account("c1", "old")).toBeUndefined();
    expect(links(tok("OTHER"))).toEqual(["kept"]);
    expect(entitlements.getCustomer("c1")).toBeDefined();
  });

  test("empty accounts deletes the device and its orphaned accounts", async () => {
    await setup();
    await expectSuccess(
      register("c1", tok("T"), [
        { username: "u1", session: session("1") },
        { username: "u2", session: session("2") },
      ]),
    );
    await expectSuccess(register("c1", tok("T"), []));
    expect(links(tok("T"))).toBeNull();
    expect(accountCount()).toBe(0);
    expect(deps.db.select().from(deviceAccounts).all()).toHaveLength(0);
    // Unknown device with no accounts: nothing to do, still success.
    await expectSuccess(register("c1", tok("NEVER-SEEN"), []));
  });

  test("legacy shared token: the next registration narrows the links and prunes the rest", async () => {
    await setup();
    // What legacyImport produces for a token two v1 customers shared: one
    // device owned by the most recent customer, linked to both customers' accounts.
    const c1 = entitlements.ensureCustomer("c1");
    const c2 = entitlements.ensureCustomer("c2");
    const now = deps.clock.now();
    const insertAccount = (customerId: number, username: string) =>
      deps.db
        .insert(redditAccounts)
        .values({
          customerId,
          username,
          sessionEnc: v1Encrypt(session(username), TEST_KEY),
          nextCheckAt: now,
          baselineAt: now - HOUR,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    const a1 = insertAccount(c1.id, "u1");
    const a2 = insertAccount(c2.id, "u2");
    const device = deps.db
      .insert(devices)
      .values({
        pushToken: tok("SHARED"),
        customerId: c2.id,
        lastRegisteredAt: now,
        createdAt: now,
      })
      .returning()
      .get();
    deps.db
      .insert(deviceAccounts)
      .values([
        { deviceId: device.id, accountId: a1.id },
        { deviceId: device.id, accountId: a2.id },
      ])
      .run();

    // The phone is really c1's.
    await expectSuccess(
      register("c1", tok("SHARED"), [{ username: "u1", session: session("u1") }]),
    );
    const after = deps.db
      .select()
      .from(devices)
      .where(eq(devices.pushToken, tok("SHARED")))
      .get()!;
    expect(after.id).toBe(device.id);
    expect(after.customerId).toBe(c1.id);
    expect(links(tok("SHARED"))).toEqual(["u1"]);
    // u1 kept its row and baseline (no notification burst); u2 was pruned.
    expect(account("c1", "u1")).toMatchObject({ id: a1.id, baselineAt: now - HOUR });
    expect(account("c2", "u2")).toBeUndefined();
  });

  test("the same username under two customers stays two accounts", async () => {
    await setup();
    await expectSuccess(register("c1", tok("A"), [{ username: "alice", session: session("1") }]));
    await expectSuccess(register("c2", tok("B"), [{ username: "alice", session: session("2") }]));
    expect(accountCount()).toBe(2);
    expect(decryptSession("c1", "alice")).toBe(session("1"));
    expect(decryptSession("c2", "alice")).toBe(session("2"));
  });

  test("bounds: 400 just past each limit, 200 at it", async () => {
    await setup();
    const tokOfLength = (n: number) => tok("x".repeat(n - tok("").length));
    const ok = { username: "u", session: "s" };
    const cases: [unknown, number][] = [
      [{ customerId: "c1", pushToken: tokOfLength(MAX_PUSH_TOKEN_CHARS), accounts: [ok] }, 200],
      [{ customerId: "c1", pushToken: tokOfLength(MAX_PUSH_TOKEN_CHARS + 1), accounts: [ok] }, 400],
      // The app only ever sends Expo tokens (Notifications.getExpoPushTokenAsync).
      [{ customerId: "c1", pushToken: "t".repeat(40), accounts: [ok] }, 400],
      [{ customerId: "c1", pushToken: "ExponentPushToken[abc", accounts: [ok] }, 400],
      [{ customerId: "c1", pushToken: "", accounts: [ok] }, 400],
      [
        {
          customerId: "c1",
          pushToken: tok("t"),
          accounts: Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({
            username: `u${i}`,
            session: "s",
          })),
        },
        200,
      ],
      [
        {
          customerId: "c1",
          pushToken: tok("t"),
          accounts: Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => ({
            username: `u${i}`,
            session: "s",
          })),
        },
        400,
      ],
      [{ customerId: "c1", pushToken: tok("t"), accounts: [{ username: "", session: "s" }] }, 400],
      [
        {
          customerId: "c1",
          pushToken: tok("t"),
          accounts: [{ username: "u".repeat(MAX_USERNAME_CHARS), session: "s" }],
        },
        200,
      ],
      [
        {
          customerId: "c1",
          pushToken: tok("t"),
          accounts: [{ username: "u".repeat(MAX_USERNAME_CHARS + 1), session: "s" }],
        },
        400,
      ],
      [
        {
          customerId: "c1",
          pushToken: tok("t"),
          accounts: [{ username: "u", session: "s".repeat(MAX_SESSION_BYTES) }],
        },
        200,
      ],
      [
        {
          customerId: "c1",
          pushToken: tok("t"),
          accounts: [{ username: "u", session: "s".repeat(MAX_SESSION_BYTES + 1) }],
        },
        400,
      ],
      // 16 KB is bytes, not characters.
      [
        {
          customerId: "c1",
          pushToken: tok("t"),
          accounts: [{ username: "u", session: "é".repeat(MAX_SESSION_BYTES / 2 + 1) }],
        },
        400,
      ],
      [{ customerId: "bad/id", pushToken: tok("t"), accounts: [ok] }, 400],
      [{ customerId: "c1", pushToken: tok("t") }, 400],
      [{ customerId: "c1", pushToken: tok("t"), accounts: [{ username: "u" }] }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await app.fetch(appPost("/api/notifications/register", body));
      expect({ body: JSON.stringify(body).slice(0, 80), status: res.status }).toEqual({
        body: JSON.stringify(body).slice(0, 80),
        status,
      });
    }
    expect((await app.fetch(appPost("/api/notifications/register", "not json"))).status).toBe(400);
  });

  test("official: RevenueCat is refreshed before the transaction; a failure never fails the request", async () => {
    await setup("official");
    deps.fetch.on("GET", rcCustomerUrl("c1"), new TypeError("connection reset"));
    await expectSuccess(register("c1", tok("T"), [{ username: "u", session: session("1") }]));
    expect(deps.fetch.calls).toHaveLength(1);
    // Not known to be Pro, so nothing is stored (only Pro accounts are polled).
    expect(links(tok("T"))).toBeNull();
    expect(accountCount()).toBe(0);

    deps.clock.advance(HOUR);
    deps.fetch.on("GET", rcCustomerUrl("c1"), rcCustomer([{ expires_at: null }]));
    await expectSuccess(register("c1", tok("T"), [{ username: "u", session: session("1") }]));
    expect(entitlements.getCustomer("c1")?.isPro).toBe(true);
    expect(links(tok("T"))).toEqual(["u"]);
  });

  test("selfhost never calls RevenueCat", async () => {
    await setup("selfhost");
    await expectSuccess(register("c1", tok("T"), [{ username: "u", session: session("1") }]));
    expect(deps.fetch.calls).toHaveLength(0);
  });

  test("a repeated username in one request is stored once (last wins)", async () => {
    await setup();
    await expectSuccess(
      register("c1", tok("T"), [
        { username: "u", session: session("1") },
        { username: "u", session: session("2") },
      ]),
    );
    expect(accountCount()).toBe(1);
    expect(decryptSession("c1", "u")).toBe(session("2"));
  });
});

describe("devices sharing an account", () => {
  // Two phones of one customer logged in to the same Reddit account
  // separately: both keep receiving its notifications.
  test("a new session from one device keeps the other devices' links", async () => {
    await setup();
    await expectSuccess(register("c1", tok("PHONE"), [{ username: "u", session: session("1") }]));
    await expectSuccess(register("c1", tok("TABLET"), [{ username: "u", session: session("2") }]));
    expect(links(tok("PHONE"))).toEqual(["u"]);
    expect(links(tok("TABLET"))).toEqual(["u"]);
    expect(decryptSession("c1", "u")).toBe(session("2"));
    // Removing it on one device keeps it for the other.
    await expectSuccess(register("c1", tok("PHONE"), []));
    expect(links(tok("TABLET"))).toEqual(["u"]);
    expect(account("c1", "u")).toBeDefined();
  });
});

/** n accounts named u<from>…, all with the same session. */
const names = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ username: `u${from + i}`, session: session("s") }));

describe("limits", () => {
  test(`a customer keeps at most ${MAX_DEVICES_PER_CUSTOMER} devices; the least recently registered goes`, async () => {
    await setup();
    for (let i = 0; i <= MAX_DEVICES_PER_CUSTOMER; i++) {
      deps.clock.advance(1_000);
      await expectSuccess(
        register("c1", tok(`D${i}`), [{ username: `u${i}`, session: session("s") }]),
      );
    }
    expect(deps.db.select().from(devices).all()).toHaveLength(MAX_DEVICES_PER_CUSTOMER);
    expect(links(tok("D0"))).toBeNull();
    expect(account("c1", "u0")).toBeUndefined();
    expect(links(tok(`D${MAX_DEVICES_PER_CUSTOMER}`))).toEqual([`u${MAX_DEVICES_PER_CUSTOMER}`]);
  });

  test(`a customer keeps at most ${MAX_ACCOUNTS_PER_CUSTOMER} accounts across its devices`, async () => {
    await setup();
    await expectSuccess(register("c1", tok("A"), names(0, MAX_ACCOUNTS_PER_CUSTOMER - 2)));
    // B keeps one of A's accounts and asks for 5 new ones: only 2 fit.
    await expectSuccess(register("c1", tok("B"), [...names(0, 1), ...names(100, 5)]));
    expect(accountCount()).toBe(MAX_ACCOUNTS_PER_CUSTOMER);
    expect(links(tok("B"))).toHaveLength(3);
    // Existing accounts can always be re-registered.
    await expectSuccess(register("c1", tok("A"), names(0, MAX_ACCOUNTS_PER_CUSTOMER - 2)));
    expect(links(tok("A"))).toHaveLength(MAX_ACCOUNTS_PER_CUSTOMER - 2);
  });

  test("a device left with no links is deleted", async () => {
    await setup();
    await expectSuccess(register("c1", tok("A"), names(0, MAX_ACCOUNTS_PER_CUSTOMER)));
    // Every account B asks for is over the cap, so B would link to nothing.
    await expectSuccess(register("c1", tok("B"), names(100, 1)));
    expect(links(tok("B"))).toBeNull();
    expect(deps.db.select().from(devices).all()).toHaveLength(1);
  });

  test(`more than ${REGISTER_BURST} registrations in a burst from one network are throttled`, async () => {
    await setup();
    const body = { customerId: "c1", pushToken: tok("T"), accounts: [] };
    const from = (ip: string) =>
      app.fetch(appPost("/api/notifications/register", body), { remoteAddr: ip });
    for (let i = 0; i < REGISTER_BURST; i++) expect((await from("203.0.113.7")).status).toBe(200);
    const throttled = await from("203.0.113.7");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("3");
    // Another network is unaffected; the bucket refills.
    expect((await from("198.51.100.1")).status).toBe(200);
    deps.clock.advance(3_000);
    expect((await from("203.0.113.7")).status).toBe(200);
  });
});

describe("official mode: only Pro customers are stored", () => {
  // Unentitled accounts are never polled, so they never push, never get a
  // DeviceNotRegistered and were never pruned: anyone could fill the volume.
  test("a customer RevenueCat doesn't know as Pro stores nothing; an empty list still deletes", async () => {
    await setup("official");
    deps.fetch.on("GET", rcCustomerUrl("c1"), { status: 404 });
    await expectSuccess(register("c1", tok("T"), [{ username: "u", session: session("1") }]));
    expect(accountCount()).toBe(0);
    expect(deps.db.select().from(devices).all()).toHaveLength(0);
    expect(deps.metrics.get("registration.devices.not_entitled")).toBe(1);

    // A lapsed customer's existing device can still unregister.
    const now = deps.clock.now();
    deps.db
      .insert(devices)
      .values({
        pushToken: tok("OLD"),
        customerId: entitlements.ensureCustomer("c1").id,
        lastRegisteredAt: now,
        createdAt: now,
      })
      .run();
    await expectSuccess(register("c1", tok("OLD"), []));
    expect(deps.db.select().from(devices).all()).toHaveLength(0);
  });

  test("RevenueCat calls for unentitled customers share a global budget", async () => {
    await setup("official");
    deps.fetch.on("GET", /customers\//, { status: 404 });
    for (let i = 0; i < UNENTITLED_REFRESH_BURST + 5; i++) {
      const res = await app.fetch(appPost("/api/customers/register", { customerId: `anon${i}` }), {
        remoteAddr: `198.51.100.${i % 250}`,
      });
      expect(res.status).toBe(200);
    }
    expect(deps.fetch.calls).toHaveLength(UNENTITLED_REFRESH_BURST);
    expect(deps.metrics.get("registration.refresh_budget_exhausted")).toBe(5);
  });

  test("an entitled customer's refresh doesn't use the unentitled budget", async () => {
    await setup("official");
    deps.fetch.on("GET", /customers\/anon/, { status: 404 });
    deps.fetch.on("GET", rcCustomerUrl("pro"), rcCustomer([{ expires_at: null }]));
    entitlements.ensureCustomer("pro");
    await entitlements.refreshIfStale("pro", 0);
    for (let i = 0; i < UNENTITLED_REFRESH_BURST; i++) {
      await app.fetch(appPost("/api/customers/register", { customerId: `anon${i}` }), {
        remoteAddr: `198.51.100.${i % 250}`,
      });
    }
    const before = deps.fetch.calls.length;
    deps.clock.advance(11 * 60 * 1000);
    await expectSuccess(app.fetch(appPost("/api/customers/register", { customerId: "pro" })));
    expect(deps.fetch.calls.length).toBe(before + 1);
  });

  test("devices that haven't registered for 30 days expire, then their accounts and lapsed customers", async () => {
    await setup("official");
    deps.fetch.on("GET", rcCustomerUrl("c1"), rcCustomer([{ expires_at: null }]));
    deps.fetch.on("GET", rcCustomerUrl("c2"), rcCustomer([{ expires_at: null }]));
    deps.fetch.on("GET", rcCustomerUrl("c3"), rcCustomer([{ expires_at: null }]));
    const start = deps.clock.now();
    await expectSuccess(register("c1", tok("STALE"), [{ username: "u1", session: session("1") }]));
    await expectSuccess(register("c2", tok("LAPSED"), [{ username: "u2", session: session("2") }]));
    await expectSuccess(register("c3", tok("ACTIVE"), [{ username: "u3", session: session("3") }]));
    deps.db.update(customers).set({ isPro: false }).where(eq(customers.customerId, "c2")).run();
    // c3's app is opened again 20 days later.
    deps.clock.advance(20 * 24 * HOUR);
    await expectSuccess(register("c3", tok("ACTIVE"), [{ username: "u3", session: session("3") }]));

    expect(pruneStaleDevices(deps.sqlite, start + DEVICE_EXPIRY_MS - 1)).toEqual({
      devices: 0,
      accounts: 0,
      customers: 0,
    });
    // Entitled or not, a device that hasn't registered for 30 days goes. Only
    // the customer who is no longer Pro goes with it; c1's row stays for its
    // subscription.
    expect(pruneStaleDevices(deps.sqlite, start + DEVICE_EXPIRY_MS + 1)).toEqual({
      devices: 2,
      accounts: 2,
      customers: 1,
    });
    expect(links(tok("STALE"))).toBeNull();
    expect(links(tok("LAPSED"))).toBeNull();
    expect(links(tok("ACTIVE"))).toEqual(["u3"]);
    expect(entitlements.getCustomer("c1")).toBeDefined();
    expect(entitlements.getCustomer("c2")).toBeUndefined();
  });
});
