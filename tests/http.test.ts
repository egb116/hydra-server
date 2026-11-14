import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildApp } from "../src/http/app";
import { readJson } from "../src/http/body";
import { clientIp, resolveClientIp } from "../src/http/clientIp";
import { SERVER_ERROR_ALERT_THRESHOLD } from "../src/http/middleware";
import {
  BadRequest,
  Forbidden,
  NotFound,
  TooManyRequests,
  Unavailable,
  Upstream,
} from "../src/lib/errors";
import { TokenBucket } from "../src/lib/limiter";
import type { App, Module } from "../src/types";
import { SERVER_VERSION } from "../src/version";
import { type TestDeps, testDeps } from "./helpers";

let deps: TestDeps;

beforeEach(async () => {
  deps = await testDeps();
});
afterEach(() => deps.cleanup());

const echoSchema = z.object({ customerId: z.string().min(1), n: z.number().int() });

/** A module with routes that exercise the body reader and the error mapping. */
const probeModule: Module = {
  name: "probe",
  routes: (app: App) => {
    app.post("/api/echo", async (c) => c.json(await readJson(c, echoSchema)));
    app.get("/api/throw/:kind", (c) => {
      switch (c.req.param("kind")) {
        case "bad-request":
          throw new BadRequest("nope", { details: { field: "x" } });
        case "not-found":
          throw new NotFound();
        case "too-many":
          throw new TooManyRequests("Monthly usage limit exceeded", { retryAfter: 30.2 });
        case "upstream":
          throw new Upstream("model returned nothing");
        case "unavailable":
          throw new Unavailable("embeddings are not configured");
        default:
          throw new Error("kaboom: secret internals");
      }
    });
    app.get("/api/ai/forbidden", () => {
      throw new Forbidden("Customer is not subscribed");
    });
    app.get("/api/ip", (c) => c.text(clientIp(c)));
  },
};

function makeApp(modules: Module[] = [probeModule]) {
  return buildApp(deps, modules);
}

describe("GET /api/status", () => {
  test("exact body, status and version header", async () => {
    const res = await makeApp([]).request("/api/status");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Hydra server is up");
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(res.headers.get("x-hydra-server-version")).toBe(SERVER_VERSION);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /healthz", () => {
  test("200 with version when the DB and modules are healthy", async () => {
    const res = await makeApp([
      { name: "a", health: () => ({ ok: true, detail: { x: 1 } }) },
    ]).request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      version: SERVER_VERSION,
      db: { ok: true },
      modules: { a: { ok: true, detail: { x: 1 } } },
    });
  });

  test("503 when a module is unhealthy or its health check throws", async () => {
    const res = await makeApp([
      { name: "good", health: () => ({ ok: true }) },
      { name: "bad", health: () => ({ ok: false, detail: "poller stalled" }) },
    ]).request("/healthz");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, modules: { bad: { ok: false } } });

    const throwing = await makeApp([
      {
        name: "boom",
        health: () => {
          throw new Error("broken");
        },
      },
    ]).request("/healthz");
    expect(throwing.status).toBe(503);
    expect(await throwing.json()).toMatchObject({
      modules: { boom: { ok: false, detail: "broken" } },
    });
  });
});

describe("404s", () => {
  test("unknown /api paths get a JSON 404", async () => {
    const res = await makeApp().request("/api/tasks");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    // Wrong method on a known path is also a 404, as in v1.
    expect((await makeApp().request("/api/status", { method: "POST" })).status).toBe(404);
  });

  test("other unknown paths get a plain 404", async () => {
    const res = await makeApp().request("/dashboard");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("Not found");
  });
});

describe("legacy CORS preflight", () => {
  test("OPTIONS on any /api/* path matches v1 middleware/cors.ts exactly", async () => {
    for (const path of ["/api/status", "/api/ai/filterPosts", "/api/unknown/thing"]) {
      const res = await makeApp().request(path, {
        method: "OPTIONS",
        headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, Authorization");
    }
  });

  test("non-preflight requests get no CORS headers (v1 didn't add them)", async () => {
    const res = await makeApp().request("/api/status");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("readJson", () => {
  test("parses a JSON body sent with no Content-Type", async () => {
    const req = new Request("http://localhost/api/echo", {
      method: "POST",
      body: new Blob([JSON.stringify({ customerId: "abc", n: 3 })]), // no type → no header
    });
    expect(req.headers.get("content-type")).toBeNull();
    const res = await makeApp().request(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ customerId: "abc", n: 3 });
  });

  test("ignores a wrong Content-Type", async () => {
    const res = await makeApp().request("/api/echo", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ customerId: "abc", n: 1 }),
    });
    expect(res.status).toBe(200);
  });

  test("invalid JSON → 400", async () => {
    for (const body of ["{not json", ""]) {
      const res = await makeApp().request("/api/echo", { method: "POST", body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "invalid_json", message: "Request body is not valid JSON" },
      });
    }
  });

  test("schema failure → 400 with issues", async () => {
    const res = await makeApp().request("/api/echo", {
      method: "POST",
      body: JSON.stringify({ customerId: "", n: 1.5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe("invalid_body");
    expect(body.error.details.map((d) => d.path).sort()).toEqual(["customerId", "n"]);
  });

  test("bodies over 1 MB → 413", async () => {
    const res = await makeApp().request("/api/echo", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
});

describe("onError", () => {
  test("maps AppErrors to their status and the JSON envelope", async () => {
    const cases: [string, number, unknown][] = [
      [
        "bad-request",
        400,
        { error: { code: "bad_request", message: "nope", details: { field: "x" } } },
      ],
      ["not-found", 404, { error: { code: "not_found", message: "Not found" } }],
      ["upstream", 502, { error: { code: "upstream", message: "model returned nothing" } }],
      [
        "unavailable",
        503,
        { error: { code: "unavailable", message: "embeddings are not configured" } },
      ],
    ];
    for (const [kind, status, body] of cases) {
      const res = await makeApp().request(`/api/throw/${kind}`);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    }
  });

  test("errors on the legacy AI paths are text/plain", async () => {
    const res = await makeApp().request("/api/ai/forbidden");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("Customer is not subscribed");
  });

  test("429 sets Retry-After", async () => {
    const res = await makeApp().request("/api/throw/too-many");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("31");
  });

  test("unknown errors → 500 without internals, logged with the stack", async () => {
    const res = await makeApp().request("/api/throw/other");
    expect(res.status).toBe(500);
    const requestId = res.headers.get("x-request-id");
    expect(await res.json()).toEqual({
      error: { code: "internal", message: "Internal error", requestId },
    });
    const logged = deps.log.lines.find((l) => l["msg"] === "unhandled error");
    expect(logged?.["requestId"]).toBe(requestId);
    expect(JSON.stringify(logged?.["err"])).toContain("kaboom");
    expect(JSON.stringify(logged?.["err"])).toContain("stack");
  });

  test("alerts when 5xx responses exceed 10 per minute", async () => {
    const a = makeApp();
    for (let i = 0; i < SERVER_ERROR_ALERT_THRESHOLD; i++) await a.request("/api/throw/other");
    expect(deps.alerter.alerts).toHaveLength(0);
    await a.request("/api/throw/other");
    expect(deps.alerter.alerts.map((x) => x.key)).toEqual(["http-5xx"]);
  });

  test("one request log line per request", async () => {
    await makeApp().request("/api/throw/not-found");
    const lines = deps.log.lines.filter((l) => l["msg"] === "request");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", method: "GET", status: 404 });
    await makeApp().request("/api/status");
    expect(deps.log.lines.filter((l) => l["msg"] === "request").at(-1)?.["level"]).toBe("debug");
  });
});

describe("thrown non-Error values", () => {
  // Hono only hands Error instances to onError; requestContext catches the rest.
  const throwingModule: Module = {
    name: "throwing",
    routes: (app: App) => {
      app.get("/api/throw-string", () => {
        // oxlint-disable-next-line no-throw-literal -- this is what the test is about
        throw "boom-string";
      });
      app.get("/api/reject-object", async () => {
        await Promise.resolve();
        // oxlint-disable-next-line no-throw-literal -- this is what the test is about
        throw Object.assign(Object.create(null) as object, { reason: "plain object" });
      });
    },
  };

  test("become a logged JSON 500 with a request id and 5xx accounting", async () => {
    const a = makeApp([throwingModule]);
    for (const [path, needle] of [
      ["/api/throw-string", "boom-string"],
      ["/api/reject-object", "plain object"],
    ] as const) {
      const res = await a.request(path);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toStartWith("application/json");
      const requestId = res.headers.get("x-request-id");
      expect(requestId).toBeTruthy();
      expect(await res.json()).toEqual({
        error: { code: "internal", message: "Internal error", requestId },
      });
      const logged = deps.log.lines.filter(
        (l) => l["msg"] === "unhandled error" && l["requestId"] === requestId,
      );
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged[0]?.["err"])).toContain(needle);
      const request = deps.log.lines.filter(
        (l) => l["msg"] === "request" && l["requestId"] === requestId,
      );
      expect(request).toEqual([expect.objectContaining({ status: 500, path })]);
    }
    expect(deps.metrics.get("http.5xx")).toBe(2);
  });
});

/** An app over its own deps (for TRUST_PROXY) with a per-IP limited route. */
async function ipApp(env: Record<string, string>) {
  const d = await testDeps({ env });
  const limiter = new TokenBucket({ capacity: 2, refillPerSecond: 0.001, clock: d.clock });
  const app = buildApp(d, [
    probeModule,
    {
      name: "limited",
      routes: (a: App) =>
        a.get("/api/limited", (c) =>
          limiter.take(clientIp(c)).ok ? c.text("ok") : c.text("slow down", 429),
        ),
    },
  ]);
  const ip = async (headers: Record<string, string>, remoteAddr?: string) =>
    (await app.request("/api/ip", { headers }, remoteAddr ? { remoteAddr } : {})).text();
  return { d, app, ip, limiter };
}

describe("clientIp", () => {
  test("by default (no trusted proxy) headers are ignored: the peer address only", async () => {
    const { d, ip, app, limiter } = await ipApp({});
    try {
      expect(
        await ip({ "Fly-Client-IP": "1.1.1.1", "X-Forwarded-For": "2.2.2.2" }, "4.4.4.4"),
      ).toBe("4.4.4.4");
      expect(await ip({}, "::1")).toBe("::1");
      expect(await ip({})).toBe("unknown");
      expect(await ip({}, "not-an-ip")).toBe("unknown");
      // Rotating spoofed headers can't get past a per-IP limit.
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await app.request(
          "/api/limited",
          { headers: { "Fly-Client-IP": `203.0.113.${i}`, "X-Forwarded-For": `198.51.100.${i}` } },
          { remoteAddr: "192.0.2.7" },
        );
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 429, 429, 429]);
      expect(limiter.size).toBe(1);
    } finally {
      d.cleanup();
    }
  });

  test("on Fly: a valid Fly-Client-IP, never X-Forwarded-For", async () => {
    const { d, ip } = await ipApp({ FLY_APP_NAME: "hydra" });
    try {
      expect(
        await ip({ "Fly-Client-IP": " 1.1.1.1 ", "X-Forwarded-For": "2.2.2.2" }, "4.4.4.4"),
      ).toBe("1.1.1.1");
      expect(await ip({ "Fly-Client-IP": "2001:db8::1" }, "4.4.4.4")).toBe("2001:db8::1");
      expect(await ip({ "X-Forwarded-For": "2.2.2.2" }, "4.4.4.4")).toBe("4.4.4.4");
      // Not an IP (or absurdly long): the peer address, which also keeps logs and limiter keys small.
      expect(await ip({ "Fly-Client-IP": "x".repeat(15_000) }, "4.4.4.4")).toBe("4.4.4.4");
      expect(await ip({ "Fly-Client-IP": "1.1.1.1, 2.2.2.2" }, "4.4.4.4")).toBe("4.4.4.4");
      const logged = d.log.lines.filter((l) => l["msg"] === "request").map((l) => l["ip"]);
      expect(logged).toEqual(["1.1.1.1", "2001:db8::1", "4.4.4.4", "4.4.4.4", "4.4.4.4"]);
    } finally {
      d.cleanup();
    }
  });

  test("behind N trusted proxies: the N-th X-Forwarded-For entry from the right", async () => {
    const one = await ipApp({ TRUST_PROXY: "1" });
    const two = await ipApp({ TRUST_PROXY: "2" });
    try {
      // The client prepended a fake entry; nginx appended the real peer.
      expect(await one.ip({ "X-Forwarded-For": "198.51.100.9, 10.0.0.1" }, "127.0.0.1")).toBe(
        "10.0.0.1",
      );
      expect(await one.ip({ "Fly-Client-IP": "1.1.1.1" }, "127.0.0.1")).toBe("127.0.0.1");
      expect(await one.ip({ "X-Forwarded-For": "garbage" }, "127.0.0.1")).toBe("127.0.0.1");
      expect(await two.ip({ "X-Forwarded-For": "6.6.6.6, 5.5.5.5, 10.0.0.1" }, "127.0.0.1")).toBe(
        "5.5.5.5",
      );
      // Fewer entries than trusted hops: nothing trustworthy, use the peer.
      expect(await two.ip({ "X-Forwarded-For": "5.5.5.5" }, "127.0.0.1")).toBe("127.0.0.1");
    } finally {
      one.d.cleanup();
      two.d.cleanup();
    }
  });
});

const headers = (h: Record<string, string>) => (name: string) => h[name];

describe("resolveClientIp", () => {
  test("is a pure function of the headers, peer and trust setting", () => {
    expect(resolveClientIp(headers({ "fly-client-ip": "1.1.1.1" }), "9.9.9.9", "fly")).toBe(
      "1.1.1.1",
    );
    expect(resolveClientIp(headers({ "fly-client-ip": "1.1.1.1" }), "9.9.9.9", "none")).toBe(
      "9.9.9.9",
    );
    expect(resolveClientIp(headers({}), undefined, 1)).toBe("unknown");
  });
});
