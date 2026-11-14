/**
 * Legacy contract: server status, CORS preflight, unknown and removed paths,
 * and body limits. See tests/helpers/contractApp.ts for the harness.
 * APP = C:/…/Hydra (the mobile app), v1 = the v1 server files in this repo.
 */
import { describe, expect, test } from "bun:test";
import {
  OFFICIAL_ENV,
  SELFHOST_ENV,
  anonCustomerId,
  expoPushToken,
  sessionFor,
  useContractApps,
} from "../helpers/contractApp";

const makeApp = useContractApps();

describe("GET /api/status", () => {
  // APP:api/HydraServerStatus.ts:5-8 accepts a custom server only when
  // `response.status === 200 && (await response.text()) === "Hydra server is up"`,
  // called from APP:pages/SettingsPage/Advanced.tsx:44-50 with a bare GET.
  // v1 index.ts:20-22.
  test.each([
    ["selfhost", SELFHOST_ENV],
    ["official", OFFICIAL_ENV],
  ])("%s: 200 with exactly 'Hydra server is up'", async (_mode, env) => {
    const { request, fetch } = await makeApp({ env });
    const res = await request("/api/status");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Hydra server is up");
    // text/plain plus X-Hydra-Server-Version.
    expect(res.headers.get("content-type") ?? "").toStartWith("text/plain");
    expect(res.headers.get("x-hydra-server-version") ?? "").not.toBe("");
    // A status check never touches an upstream.
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("OPTIONS /api/* preflight", () => {
  // v1 index.ts:17-19 + middleware/cors.ts:1-9: OPTIONS on any /api/* path is a
  // 200 with an empty body and exactly these headers.
  test.each([
    "/api/status",
    "/api/ai/filterPosts",
    "/api/notifications/register",
    "/api/does-not-exist",
  ])("%s", async (path) => {
    const { request } = await makeApp({ env: SELFHOST_ENV });
    const res = await request(path, {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, Authorization");
  });
});

describe("unknown paths", () => {
  // Unknown /api/* paths are a JSON 404.
  // The app never calls these; this pins that nothing (e.g. a catch-all) answers 200.
  test.each([
    ["GET", "/api/nope"],
    ["POST", "/api/ai/summarizeEverything"],
    ["POST", "/api/customers/unregister"],
    ["GET", "/api"],
  ])("%s %s → JSON 404", async (method, path) => {
    const { request } = await makeApp({ env: SELFHOST_ENV });
    const res = await request(path, method === "POST" ? { method, body: "{}" } : { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  // Other unknown paths return a plain 404.
  test("non-/api path → plain 404", async () => {
    const { request } = await makeApp({ env: SELFHOST_ENV });
    const res = await request("/definitely/not/here");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toStartWith("text/plain");
  });
});

describe("removed v1 dashboard endpoints → 404", () => {
  // v1 routes/dashboard/index.ts:31-54 (the old dashboard's API), removed.
  // None is called by the app (grep of
  // APP for "/api/auth", "/api/tasks", "/api/db" finds nothing).
  test.each([
    ["POST", "/api/auth/verify", JSON.stringify({ apiKey: "anything" })],
    ["GET", "/api/tasks", null],
    ["GET", "/api/tasks/stats", null],
    ["GET", "/api/tasks/1", null],
    ["POST", "/api/db/query", JSON.stringify({ query: "SELECT * FROM customers" })],
    ["POST", "/api/db/generate-query", JSON.stringify({ prompt: "all customers" })],
  ])("%s %s", async (method, path, body) => {
    const { request } = await makeApp({ env: SELFHOST_ENV });
    const res = await request(path, body === null ? { method } : { method, body });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  // v1 routes/dashboard/index.ts:15-29: the SPA catch-all (`GET /*` → index.html)
  // and `/assets/*` are gone. Unknown non-/api paths are a plain 404.
  test.each(["/", "/tasks", "/assets/index-abc123.js"])(
    "GET %s is no longer the SPA",
    async (path) => {
      const { request } = await makeApp({ env: SELFHOST_ENV });
      const res = await request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    },
  );
});

describe("body limit → 413", () => {
  const ONE_MB = 1024 * 1024;

  /** A notifications/register body padded past 1 MB with one huge session. */
  function oversizedRegistration(): string {
    const body = JSON.stringify({
      customerId: anonCustomerId(1),
      pushToken: expoPushToken(1),
      accounts: [{ username: "alice", session: sessionFor("alice") + "x".repeat(ONE_MB) }],
    });
    expect(body.length).toBeGreaterThan(ONE_MB);
    return body;
  }

  // bodyLimit (1 MB). Over the wire the app's
  // request carries Content-Length (React Native's fetch sets it for string
  // bodies), so the limit applies before any route runs.
  test("with Content-Length, as it arrives over the wire", async () => {
    const { request, fetch } = await makeApp({ env: OFFICIAL_ENV });
    const body = oversizedRegistration();
    const res = await request("/api/notifications/register", {
      method: "POST",
      body,
      headers: { "Content-Length": String(Buffer.byteLength(body)) },
    });
    expect(res.status).toBe(413);
    expect(fetch.calls).toHaveLength(0);
  });

  // Same, with no headers at all (APP:api/Notifications.ts:9-16), so the limit
  // is only noticed while the route reads the body.
  test("without Content-Length, as the app's code builds it", async () => {
    const { post, fetch } = await makeApp({ env: OFFICIAL_ENV });
    const res = await post("/api/notifications/register", JSON.parse(oversizedRegistration()));
    expect(res.status).toBe(413);
    expect(fetch.calls).toHaveLength(0);
  });

  test("an oversized AI request is also a 413", async () => {
    const { post, fetch } = await makeApp({ env: SELFHOST_ENV });
    const res = await post("/api/ai/askQuestion", {
      question: "q",
      docs: ["d".repeat(ONE_MB + 1)],
    });
    expect(res.status).toBe(413);
    // Text, like every AI-route error: pre-711547c apps render the
    // summarize routes' body as the summary (APP:api/AI.ts).
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(fetch.calls).toHaveLength(0);
  });
});
