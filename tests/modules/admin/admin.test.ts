import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildApp } from "../../../src/http/app";
import type { Heartbeat } from "../../../src/lib/jobs";
import type { ProxyHealthSnapshot } from "../../../src/modules/contracts";
import { createAdminModule, LOGIN_ATTEMPTS_PER_MINUTE } from "../../../src/modules/admin";
import { escapeHtml, formatValue } from "../../../src/modules/admin/render";
import { SESSION_TTL_MS } from "../../../src/modules/admin/session";
import { type AdminStats, STATS_CACHE_MS } from "../../../src/modules/admin/stats";
import type { App, Deps } from "../../../src/types";
import { FAKE_NOW, type TestDeps, testConfig, testDeps } from "../../helpers";

const PASSWORD = "correct horse battery staple";
const ORIGIN = "http://localhost";

let deps: TestDeps;
let proxy: ProxyHealthSnapshot;

const heartbeat: Heartbeat = {
  lastStart: FAKE_NOW - 5_000,
  lastEnd: FAKE_NOW - 4_000,
  lastDurationMs: 1_000,
  lastError: null,
  runs: 3,
  failures: 1,
  consecutiveFailures: 0,
  skipped: 0,
  running: false,
};

beforeEach(async () => {
  deps = await testDeps({ env: { DASHBOARD_PASSWORD: PASSWORD } });
  proxy = {
    configured: true,
    total: 10,
    healthy: 7,
    lastRefreshAt: FAKE_NOW - 60_000,
    lastRefreshError: null,
  };
});
afterEach(() => deps.cleanup());

function makeApp(d: Deps = deps): App {
  const admin = createAdminModule(d, {
    heartbeats: () => ({ "push-receipts": heartbeat, "db-backup": { ...heartbeat, runs: 1 } }),
    proxyHealth: () => proxy,
  });
  return buildApp(d, [admin]);
}

function loginRequest(
  password: string,
  headers: Record<string, string> = { origin: ORIGIN },
  url = "/admin/login",
): RequestInit & { url: string } {
  return {
    url,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ password }).toString(),
  };
}

async function postLogin(
  app: App,
  password: string,
  headers?: Record<string, string>,
  url?: string,
): Promise<Response> {
  const { url: target, ...init } = loginRequest(password, headers, url);
  return app.request(target, init);
}

/** The `name=value` part of the session Set-Cookie header. */
function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie");
  expect(header).not.toBeNull();
  const pair = header!.split(";")[0]!;
  expect(pair.startsWith("hydra_admin=")).toBe(true);
  return pair;
}

async function login(app: App): Promise<string> {
  const res = await postLogin(app, PASSWORD);
  expect(res.status).toBe(303);
  return sessionCookie(res);
}

async function get(app: App, path: string, cookie?: string): Promise<Response> {
  return await app.request(path, { headers: cookie === undefined ? {} : { cookie } });
}

describe("login", () => {
  test("GET /admin/login serves the form with security headers", async () => {
    const res = await get(makeApp(), "/admin/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('action="/admin/login"');
    expect(html).toContain('type="password"');
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  test("the right password sets a 12 h HttpOnly, SameSite=Strict, Path=/admin cookie", async () => {
    const app = makeApp();
    const res = await postLogin(app, PASSWORD);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    const header = res.headers.get("set-cookie")!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/admin");
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(header).not.toContain("Secure");

    const page = await get(app, "/admin", sessionCookie(res));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hydra admin");
    expect(deps.metrics.get("admin.logins")).toBe(1);
  });

  test("the cookie is Secure on https", async () => {
    const res = await postLogin(
      makeApp(),
      PASSWORD,
      { origin: "https://localhost" },
      "https://localhost/admin/login",
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("X-Forwarded-Proto marks the cookie Secure only behind a trusted proxy", async () => {
    const untrusted = await postLogin(makeApp(), PASSWORD, {
      origin: ORIGIN,
      "x-forwarded-proto": "https",
    });
    expect(untrusted.status).toBe(303);
    expect(untrusted.headers.get("set-cookie")).not.toContain("Secure");

    const trusted = await testDeps({ env: { DASHBOARD_PASSWORD: PASSWORD, TRUST_PROXY: "1" } });
    try {
      const res = await postLogin(makeApp(trusted), PASSWORD, {
        origin: ORIGIN,
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.9",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("set-cookie")).toContain("Secure");
    } finally {
      trusted.cleanup();
    }
  });

  test("a wrong password is a 401 without a cookie", async () => {
    const app = makeApp();
    for (const attempt of ["wrong password, long enough", "", `${PASSWORD} `, "x".repeat(5000)]) {
      const res = await postLogin(app, attempt);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain("Incorrect password.");
    }
    expect(deps.log.lines.some((l) => l["msg"] === "admin login failed")).toBe(true);
  });

  test("a body without a password field fails cleanly", async () => {
    const res = await makeApp().request("/admin/login", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(401);
  });

  test("GET /admin/login redirects to /admin when already logged in", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const res = await get(app, "/admin/login", cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin");
  });
});

describe("login rate limit", () => {
  test(`${LOGIN_ATTEMPTS_PER_MINUTE} attempts per minute per IP, even with the right password`, async () => {
    const trusted = await testDeps({ env: { DASHBOARD_PASSWORD: PASSWORD, TRUST_PROXY: "1" } });
    try {
      const app = makeApp(trusted);
      const from = (ip: string) => ({ origin: ORIGIN, "x-forwarded-for": ip });
      for (let i = 0; i < LOGIN_ATTEMPTS_PER_MINUTE; i++) {
        expect((await postLogin(app, "wrong", from("198.51.100.1"))).status).toBe(401);
      }
      const limited = await postLogin(app, PASSWORD, from("198.51.100.1"));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("set-cookie")).toBeNull();
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(limited.headers.get("x-frame-options")).toBe("DENY");

      // Another IP has its own bucket.
      expect((await postLogin(app, PASSWORD, from("198.51.100.2"))).status).toBe(303);

      // One attempt refills every 60/5 = 12 s.
      trusted.clock.advance(12_000);
      expect((await postLogin(app, PASSWORD, from("198.51.100.1"))).status).toBe(303);
      expect((await postLogin(app, PASSWORD, from("198.51.100.1"))).status).toBe(429);
    } finally {
      trusted.cleanup();
    }
  });
});

/** Changes the last character of a signature. */
function flip(s: string): string {
  return s.endsWith("A") ? `${s.slice(0, -1)}B` : `${s.slice(0, -1)}A`;
}

describe("session cookie", () => {
  test("a tampered cookie is rejected", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const value = cookie.slice("hydra_admin=".length);
    const [iat, exp, sig] = value.split(".") as [string, string, string];
    const tampered = [
      `${iat}.${Number(exp) + SESSION_TTL_MS}.${sig}`, // extended expiry
      `${iat}.${exp}.${flip(sig)}`, // bad signature
      `${iat}.${exp}`, // no signature
      `${iat}.${exp}.${sig}x`,
      "",
      "garbage",
    ];
    for (const bad of tampered) {
      const res = await get(app, "/admin", `hydra_admin=${bad}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin/login");
    }
    expect((await get(app, "/admin", cookie)).status).toBe(200);
  });

  test("a session expires after 12 hours", async () => {
    const app = makeApp();
    const cookie = await login(app);
    deps.clock.advance(SESSION_TTL_MS - 1);
    expect((await get(app, "/admin/api/stats", cookie)).status).toBe(200);
    deps.clock.advance(1);
    expect((await get(app, "/admin/api/stats", cookie)).status).toBe(401);
  });

  test("changing the password invalidates existing sessions", async () => {
    const cookie = await login(makeApp());

    // Same password and key (a restart): the session survives.
    const restarted = makeApp({
      ...deps,
      config: testConfig({ DASHBOARD_PASSWORD: PASSWORD, DATABASE_PATH: deps.dbPath }),
    });
    expect((await get(restarted, "/admin", cookie)).status).toBe(200);

    const changed = makeApp({
      ...deps,
      config: testConfig({
        DASHBOARD_PASSWORD: "a completely different password",
        DATABASE_PATH: deps.dbPath,
      }),
    });
    const res = await get(changed, "/admin", cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  test("changing the encryption key invalidates existing sessions", async () => {
    const cookie = await login(makeApp());
    const rotated = makeApp({
      ...deps,
      config: testConfig({
        DASHBOARD_PASSWORD: PASSWORD,
        ENCRYPTION_KEY: "ab".repeat(32),
        DATABASE_PATH: deps.dbPath,
      }),
    });
    expect((await get(rotated, "/admin", cookie)).status).toBe(302);
  });

  test("logout clears the cookie and revokes the session", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const res = await app.request("/admin/logout", {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/login");
    const cleared = res.headers.get("set-cookie")!;
    expect(cleared).toContain("hydra_admin=;");
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/admin");
    // A copy of the old cookie no longer works.
    expect((await get(app, "/admin", cookie)).status).toBe(302);
    // Logging in again (even in the same millisecond) works.
    const fresh = await login(app);
    expect((await get(app, "/admin", fresh)).status).toBe(200);
  });
});

describe("auth gate", () => {
  test("pages redirect to the login form and the API answers 401 JSON", async () => {
    const app = makeApp();
    for (const path of ["/admin", "/admin/", "/admin/anything", "/admin/api/nope"]) {
      const res = await get(app, path);
      if (path.startsWith("/admin/api/")) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
          error: { code: "unauthorized", message: "Not logged in" },
        });
      } else {
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/admin/login");
      }
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    const api = await get(app, "/admin/api/stats");
    expect(api.status).toBe(401);
    const logout = await app.request("/admin/logout", {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(logout.status).toBe(302);
  });

  test("paths that only start with /admin are not gated", async () => {
    const res = await get(makeApp(), "/administrator");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  test("without DASHBOARD_PASSWORD the module mounts nothing", async () => {
    const off = await testDeps();
    try {
      expect(off.config.dashboardPassword).toBeNull();
      const module = createAdminModule(off, { heartbeats: () => ({}), proxyHealth: () => proxy });
      expect(module.routes).toBeUndefined();
      const res = await buildApp(off, [module]).request("/admin");
      expect(res.status).toBe(404);
    } finally {
      off.cleanup();
    }
  });

  test("the dashboard has a nonce CSP with no unsafe-inline, and the API is no-store JSON", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const res = await get(app, "/admin", cookie);
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("connect-src 'self'");
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain('fetch("/admin", { method: "HEAD"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toMatch(/ style="/);

    const again = await get(app, "/admin", cookie);
    expect(again.headers.get("content-security-policy")).not.toBe(csp);

    // The reload script's probe: 200 while logged in, the login redirect after.
    const probe = (c?: string) =>
      app.request("/admin", { method: "HEAD", headers: c === undefined ? {} : { cookie: c } });
    expect((await probe(cookie)).status).toBe(200);
    const expired = await probe();
    expect(expired.status).toBe(302);
    expect(expired.headers.get("location")).toBe("/admin/login");

    const api = await get(app, "/admin/api/stats", cookie);
    expect(api.status).toBe(200);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(api.headers.get("cache-control")).toBe("no-store");
  });
});

// ------------------------------------------------------------------- seeding

const HOUR = 3_600_000;

function seed(d: TestDeps): void {
  const now = d.clock.now();
  const db = d.sqlite;
  const customer = db.prepare(
    "INSERT INTO customers (id, customer_id, is_pro, pro_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  customer.run(1, "$RCAnonymousID:aaaaaaaaaaaa111111", 1, null, now, now);
  customer.run(2, "$RCAnonymousID:bbbbbbbbbbbb222222", 1, now + HOUR, now, now);
  customer.run(3, "$RCAnonymousID:cccccccccccc333333", 1, now - HOUR, now, now); // lapsed
  customer.run(4, "short", 0, null, now, now);

  const device = db.prepare(
    "INSERT INTO devices (id, push_token, customer_id, last_registered_at, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  device.run(1, "ExponentPushToken[1]", 1, now, now);
  device.run(2, "ExponentPushToken[2]", 1, now, now);
  device.run(3, "ExponentPushToken[3]", 2, now, now);

  const account = db.prepare(
    `INSERT INTO reddit_accounts (id, customer_id, username, session_enc, status, next_check_at, lease_until,
       consecutive_failures, session_failures, last_error, last_error_at, baseline_at, created_at, updated_at)
     VALUES (?, ?, ?, 'enc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Due 90 s ago, unleased: the queue lag.
  account.run(1, 1, "alice", "active", now - 90_000, null, 0, 0, null, null, now, now, now);
  // Due 10 min ago but leased (in flight): due, but not waiting.
  account.run(
    2,
    1,
    "bob",
    "active",
    now - 600_000,
    now + 60_000,
    2,
    0,
    "timeout",
    now - 5_000,
    now,
    now,
    now,
  );
  // Not due.
  account.run(
    3,
    2,
    "carol",
    "needs_reauth",
    now + 11 * HOUR,
    null,
    0,
    2,
    "session_dead: invalid",
    now - 1_000,
    now,
    now,
    now,
  );
  account.run(
    4,
    2,
    "dave",
    "active",
    now + 60_000,
    null,
    1,
    0,
    "edge_block",
    now - 60_000,
    now,
    now,
    now,
  );

  // alice and bob are on customer 1's devices, so the poller would claim them.
  const link = db.prepare("INSERT INTO device_accounts (device_id, account_id) VALUES (?, ?)");
  link.run(1, 1);
  link.run(2, 2);
  link.run(3, 3);

  const call = db.prepare(
    `INSERT INTO ai_calls (ts, feature, model, customer_id, input_tokens, output_tokens, cost_usd, latency_ms, status, error)
     VALUES (?, ?, 'm', ?, ?, ?, ?, 100, ?, ?)`,
  );
  call.run(now - HOUR, "summarizePost", "c1", 1000, 200, 0.5, "ok", null);
  call.run(now - 2 * HOUR, "summarizePost", "c1", 500, 100, 0.25, "ok", null);
  call.run(now - HOUR, "filterPosts", "c2", 3000, 50, 0.1, "error", "timeout");
  // Last month: never counted.
  call.run(Date.UTC(2026, 9, 31, 23, 0), "summarizePost", "c1", 9999, 9999, 99, "ok", null);

  const usage = db.prepare(
    "INSERT INTO ai_usage_monthly (customer_id, month, request_count, cost_usd) VALUES (?, ?, ?, ?)",
  );
  usage.run("$RCAnonymousID:aaaaaaaaaaaa111111", "2026-11", 2, 0.75);
  usage.run("$RCAnonymousID:bbbbbbbbbbbb222222", "2026-11", 1, 0.1);
  usage.run("short", "2026-11", 1, 1.5);
  usage.run("$RCAnonymousID:aaaaaaaaaaaa111111", "2026-10", 50, 99);

  const ticket = db.prepare(
    "INSERT INTO push_tickets (ticket_id, push_token, created_at) VALUES (?, ?, ?)",
  );
  ticket.run("t1", "ExponentPushToken[1]", now - 20 * 60_000);
  ticket.run("t2", "ExponentPushToken[1]", now - 60_000);

  d.metrics.inc("poller.checks", 12);
  d.metrics.set("poller.in_flight", 2);
  d.metrics.inc("push.sent", 4);
  d.metrics.inc("reddit.edge_block");
}

async function stats(app: App, cookie: string): Promise<AdminStats> {
  const res = await get(app, "/admin/api/stats", cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as AdminStats;
}

describe("stats", () => {
  test("the JSON shape on a seeded database", async () => {
    seed(deps);
    const app = makeApp();
    const cookie = await login(app);
    const s = await stats(app, cookie);

    expect(s.generatedAt).toBe(FAKE_NOW);
    expect(s.bootedAt).toBe(FAKE_NOW);
    expect(s.mode).toBe("selfhost");
    expect(s.accounts).toEqual({
      total: 4,
      active: 3,
      needsReauth: 1,
      dueNow: 2,
      queueLagMs: 90_000,
      recentErrors: [
        {
          username: "carol",
          status: "needs_reauth",
          error: "session_dead: invalid",
          at: FAKE_NOW - 1_000,
          consecutiveFailures: 0,
          sessionFailures: 2,
        },
        {
          username: "bob",
          status: "active",
          error: "timeout",
          at: FAKE_NOW - 5_000,
          consecutiveFailures: 2,
          sessionFailures: 0,
        },
        {
          username: "dave",
          status: "active",
          error: "edge_block",
          at: FAKE_NOW - 60_000,
          consecutiveFailures: 1,
          sessionFailures: 0,
        },
      ],
    });
    expect(s.customers).toEqual({ total: 4, pro: 2, withDevices: 2, devices: 3 });
    expect(s.poller).toEqual([
      { name: "poller.checks", value: 12 },
      { name: "poller.in_flight", value: 2 },
    ]);
    expect(s.push).toEqual({
      pendingReceipts: 2,
      oldestPendingAt: FAKE_NOW - 20 * 60_000,
      metrics: [{ name: "push.sent", value: 4 }],
    });
    expect(s.otherMetrics.map((m) => m.name)).toContain("reddit.edge_block");
    expect(s.otherMetrics.map((m) => m.name)).toContain("admin.logins");
    expect(s.proxy).toEqual(proxy);
    expect(s.jobs.map((j) => j.name)).toEqual(["db-backup", "push-receipts"]);
    expect(s.jobs[1]).toEqual({ name: "push-receipts", ...heartbeat });

    expect(s.ai.month).toBe("2026-11");
    expect(s.ai.calls).toBe(3);
    expect(s.ai.totalUsd).toBeCloseTo(0.85, 10);
    expect(s.ai.byFeature).toHaveLength(2);
    expect(s.ai.byFeature[0]).toMatchObject({
      feature: "summarizePost",
      calls: 2,
      errors: 0,
      inputTokens: 1500,
      outputTokens: 300,
    });
    expect(s.ai.byFeature[0]!.costUsd).toBeCloseTo(0.75, 10);
    expect(s.ai.byFeature[1]).toMatchObject({ feature: "filterPosts", calls: 1, errors: 1 });
    expect(s.ai.customers).toBe(3);
    expect(s.ai.topCustomers).toEqual([
      { customer: "short", requests: 1, costUsd: 1.5 },
      { customer: "…111111", requests: 2, costUsd: 0.75 },
      { customer: "…222222", requests: 1, costUsd: 0.1 },
    ]);
    // Full customer ids never leave the server.
    expect(JSON.stringify(s)).not.toContain("aaaaaaaaaaaa");
  });

  test("due now and queue lag count only accounts the poller would claim", async () => {
    const DAY = 24 * HOUR;
    const populate = (d: TestDeps): void => {
      const now = d.clock.now();
      const db = d.sqlite;
      const customer = db.prepare(
        "INSERT INTO customers (id, customer_id, is_pro, pro_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      customer.run(1, "pro-forever", 1, null, now, now);
      customer.run(2, "pro-lapsed", 1, now - 7 * DAY, now, now);
      customer.run(3, "never-pro", 0, null, now, now);
      const device = db.prepare(
        "INSERT INTO devices (id, push_token, customer_id, last_registered_at, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      device.run(1, "ExponentPushToken[1]", 1, now, now);
      device.run(2, "ExponentPushToken[2]", 2, now, now);
      device.run(3, "ExponentPushToken[3]", 3, now, now);
      const account = db.prepare(
        `INSERT INTO reddit_accounts (id, customer_id, username, session_enc, status, next_check_at, lease_until,
           consecutive_failures, session_failures, baseline_at, created_at, updated_at)
         VALUES (?, ?, ?, 'enc', 'active', ?, ?, 0, 0, ?, ?, ?)`,
      );
      account.run(1, 1, "waiting", now - 90_000, null, now, now, now);
      account.run(2, 1, "leased", now - 600_000, now + 60_000, now, now, now);
      account.run(3, 2, "lapsed", now - 7 * DAY, null, now, now, now);
      account.run(4, 3, "free", now - DAY, null, now, now, now);
      account.run(5, 1, "unlinked", now - 2 * DAY, null, now, now, now);
      const link = db.prepare("INSERT INTO device_accounts (device_id, account_id) VALUES (?, ?)");
      link.run(1, 1);
      link.run(1, 2);
      link.run(2, 3);
      link.run(3, 4);
    };

    // Official mode: the lapsed, never-pro and unlinked accounts are never
    // claimed, so they must not show up as days of lag.
    const official = await testDeps({
      env: {
        DASHBOARD_PASSWORD: PASSWORD,
        HYDRA_MODE: "official",
        REVENUECAT_PROJECT_ID: "proj",
        REVENUECAT_API_KEY: "key",
      },
    });
    try {
      populate(official);
      const app = makeApp(official);
      const s = await stats(app, await login(app));
      expect(s.mode).toBe("official");
      expect(s.accounts.total).toBe(5);
      expect(s.accounts.dueNow).toBe(2);
      expect(s.accounts.queueLagMs).toBe(90_000);
    } finally {
      official.cleanup();
    }

    // Selfhost: entitlement doesn't matter, a device link still does.
    populate(deps);
    const app = makeApp();
    const s = await stats(app, await login(app));
    expect(s.accounts.dueNow).toBe(4);
    expect(s.accounts.queueLagMs).toBe(7 * DAY);
  });

  test("AI spend keeps counting after the retention prune empties ai_calls", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const insert = deps.sqlite.prepare(
      `INSERT INTO ai_calls (ts, feature, model, input_tokens, output_tokens, cost_usd, latency_ms, status)
       VALUES (?, ?, 'm', 10, 1, ?, 50, 'ok')`,
    );
    for (let i = 0; i < 5; i++) insert.run(deps.clock.now() - 100 * 24 * HOUR, "old", 1);
    expect((await stats(app, cookie)).ai.calls).toBe(0);

    // The prune deletes everything; AUTOINCREMENT still never reuses an id.
    deps.sqlite.run("DELETE FROM ai_calls");
    insert.run(deps.clock.now(), "summarizePost", 0.02);
    const maxId = deps.sqlite.query<{ id: number }, []>("SELECT MAX(id) AS id FROM ai_calls").get();
    expect(maxId?.id).toBe(6);
    deps.clock.advance(STATS_CACHE_MS);
    let s = await stats(app, cookie);
    expect(s.ai.calls).toBe(1);
    expect(s.ai.totalUsd).toBeCloseTo(0.02, 10);

    // Incremental adds keep working from the new mark.
    insert.run(deps.clock.now(), "summarizePost", 0.03);
    deps.clock.advance(STATS_CACHE_MS);
    s = await stats(app, cookie);
    expect(s.ai.calls).toBe(2);
  });

  test("an empty database", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const s = await stats(app, cookie);
    expect(s.accounts).toEqual({
      total: 0,
      active: 0,
      needsReauth: 0,
      dueNow: 0,
      queueLagMs: 0,
      recentErrors: [],
    });

    expect(s.ai).toEqual({
      month: "2026-11",
      totalUsd: 0,
      calls: 0,
      byFeature: [],
      customers: 0,
      topCustomers: [],
    });
    expect(s.push.pendingReceipts).toBe(0);
    expect(s.push.oldestPendingAt).toBeNull();
  });

  test("results are cached briefly, AI spend is added incrementally and resets each month", async () => {
    seed(deps);
    const app = makeApp();
    const cookie = await login(app);
    expect((await stats(app, cookie)).ai.calls).toBe(3);

    const insert = deps.sqlite.prepare(
      `INSERT INTO ai_calls (ts, feature, model, input_tokens, output_tokens, cost_usd, latency_ms, status)
       VALUES (?, ?, 'm', 10, 1, ?, 50, 'ok')`,
    );
    insert.run(deps.clock.now(), "askQuestion", 0.01);
    expect((await stats(app, cookie)).ai.calls).toBe(3); // cached

    deps.clock.advance(STATS_CACHE_MS);
    let s = await stats(app, cookie);
    expect(s.ai.calls).toBe(4);
    expect(s.ai.byFeature.find((f) => f.feature === "askQuestion")?.calls).toBe(1);

    insert.run(deps.clock.now(), "askQuestion", 0.01);
    deps.clock.advance(STATS_CACHE_MS);
    s = await stats(app, cookie);
    expect(s.ai.byFeature.find((f) => f.feature === "askQuestion")?.calls).toBe(2);
    expect(s.ai.calls).toBe(5);

    // December: November no longer counts.
    deps.clock.set(Date.UTC(2026, 11, 1, 0, 0, 1));
    insert.run(deps.clock.now(), "embedQuery", 0.001);
    s = await stats(app, await login(app));
    expect(s.ai.month).toBe("2026-12");
    expect(s.ai.byFeature).toEqual([
      {
        feature: "embedQuery",
        calls: 1,
        errors: 0,
        inputTokens: 10,
        outputTokens: 1,
        costUsd: 0.001,
      },
    ]);
  });

  test("the page shows the seeded values", async () => {
    seed(deps);
    const app = makeApp();
    const cookie = await login(app);
    const html = await (await get(app, "/admin", cookie)).text();
    for (const section of [
      "Accounts",
      "Customers and devices",
      "Poller (since boot)",
      "Proxy pool",
      "Jobs",
      "AI spend this month",
      "Push",
      "Recent account errors",
    ]) {
      expect(html).toContain(`<h2>${section}</h2>`);
    }
    expect(html).toContain('<th>Queue lag</th><td class="n">1m 30s</td>');
    expect(html).toContain('<th>Devices</th><td class="n">3</td>');
    expect(html).toContain("<td>…111111</td>");
    expect(html).toContain("<td>session_dead: invalid</td>");
    expect(html).toContain("<td>push-receipts</td>");
    expect(html).toContain("<td>poller.checks</td>");
    // Alignment: label/value values sit on the right (text too, except long
    // error text), and a number column's header sits over its values.
    expect(html).toMatch(/<th>Month \(UTC\)<\/th><td class="n">\d{4}-\d{2}<\/td>/);
    expect(html).toContain('<th>Last refresh error</th><td class="err">');
    expect(html).toContain('<th>Feature</th><th class="n">Calls</th>');
    expect(html).not.toMatch(/<th class="n">(Feature|Customer|Metric)<\/th>/);
    expect(html).not.toContain("aaaaaaaaaaaa");
  });
});

describe("HTML escaping", () => {
  test("a malicious username and error in recent errors are escaped", async () => {
    const now = deps.clock.now();
    deps.sqlite.run(
      "INSERT INTO customers (id, customer_id, is_pro, created_at, updated_at) VALUES (1, 'c<b>1', 1, ?, ?)",
      [now, now],
    );
    const username = `<script>alert("x")</script>`;
    const error = `<img src=x onerror='alert(1)'>&`;
    deps.sqlite.run(
      `INSERT INTO reddit_accounts (customer_id, username, session_enc, next_check_at, baseline_at,
         last_error, last_error_at, created_at, updated_at)
       VALUES (1, ?, 'enc', ?, ?, ?, ?, ?, ?)`,
      [username, now, now, error, now, now, now],
    );
    const app = makeApp();
    const cookie = await login(app);
    const html = await (await get(app, "/admin", cookie)).text();
    expect(html).not.toContain(username);
    expect(html).not.toContain("<img");
    expect(html).toContain("<td>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</td>");
    expect(html).toContain("<td>&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;</td>");
    // Exactly one script element: the page's own.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  test("escapeHtml covers the five special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  test("a hostile proxy refresh error is escaped too", async () => {
    proxy = { ...proxy, lastRefreshError: "</td><script>x</script>" };
    const app = makeApp();
    const cookie = await login(app);
    const html = await (await get(app, "/admin", cookie)).text();
    expect(html).toContain("&lt;/td&gt;&lt;script&gt;x&lt;/script&gt;");
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

describe("formatting", () => {
  test("known outputs", () => {
    expect(formatValue("int", 1234567)).toBe("1,234,567");
    expect(formatValue("usd", 0.00123)).toBe("$0.0012");
    expect(formatValue("usd", 12.345)).toBe("$12.35");
    expect(formatValue("time", FAKE_NOW)).toBe("2026-11-10 12:00:00Z");
    expect(formatValue("ms", 90_000)).toBe("1m 30s");
    expect(formatValue("ms", 5 * HOUR + 125_000)).toBe("5h 2m");
    expect(formatValue("text", null)).toBe("–");
  });
});
