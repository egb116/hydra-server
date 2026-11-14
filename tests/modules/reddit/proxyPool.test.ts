import { describe, expect, test } from "bun:test";
import { RedditError } from "../../../src/modules/contracts";
import {
  ALERT_KEY_REFRESH,
  ALERT_KEY_UNHEALTHY,
  COOLDOWN_MAX_MS,
  COOLDOWN_MIN_MS,
  cooldownFor,
  createProxyPool,
  READY_GRACE_MS,
  REFRESH_INTERVAL_MS,
  REFRESH_RETRY_MS,
  rendezvousPick,
  WEBSHARE_LIST_URL,
} from "../../../src/modules/reddit/proxyPool";
import { redditDeps, websharePage } from "./helpers";

const WEBSHARE = "https://proxy.webshare.io/";
const MIN = 60 * 1000;

function setup(token: string | null = "ws-token") {
  const deps = redditDeps();
  const pool = createProxyPool({ ...deps, config: { webshareToken: token } });
  return { deps, pool };
}

function noProxy(fn: () => unknown): RedditError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RedditError);
    return err as RedditError;
  }
  throw new Error("expected no_proxy");
}

describe("refresh", () => {
  test("loads every page with the token, building proxy URLs", async () => {
    const { deps, pool } = setup();
    const page2 = "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=2&page_size=100";
    deps.fetch.enqueue({ json: websharePage(["1", "2"], page2) });
    deps.fetch.enqueue({ json: websharePage(["3"]) });
    expect(await pool.refresh()).toBe(true);

    expect(deps.fetch.calls.map((c) => c.url)).toEqual([WEBSHARE_LIST_URL, page2]);
    for (const c of deps.fetch.calls) {
      expect(c.headers.get("authorization")).toBe("Token ws-token");
      expect(c.init.timeoutMs).toBeGreaterThan(0);
      expect(c.init.proxy).toBeUndefined();
    }
    expect(pool.health()).toEqual({
      configured: true,
      total: 3,
      healthy: 3,
      lastRefreshAt: deps.clock.now(),
      lastRefreshError: null,
    });
    expect(pool.assign(1, "1")).toEqual({ key: "1", url: "http://user1:pass1@10.0.0.1:8000" });
  });

  test("skips invalid and malformed entries", async () => {
    const { deps, pool } = setup();
    const page = websharePage(["1", "2"]) as { results: Record<string, unknown>[] };
    page.results.push({ id: "bad" });
    const invalid = websharePage(["9"], null, { valid: false }) as {
      results: Record<string, unknown>[];
    };
    page.results.push(...invalid.results);
    deps.fetch.enqueue({ json: page });
    await pool.refresh();
    expect(pool.health().total).toBe(2);
  });

  test("a failed refresh keeps serving the stale list, records the error and alerts", async () => {
    const { deps, pool } = setup();
    deps.fetch.enqueue({ json: websharePage(["1", "2"]) });
    await pool.refresh();
    deps.clock.advance(REFRESH_INTERVAL_MS);
    deps.fetch.enqueue({ status: 503, body: "down" });
    expect(await pool.refresh()).toBe(false);

    const health = pool.health();
    expect(health.total).toBe(2);
    expect(health.lastRefreshError).toContain("503");
    expect(health.lastRefreshAt).toBe(deps.clock.now() - REFRESH_INTERVAL_MS);
    expect(pool.assign(5, null)).not.toBeNull();
    expect(deps.alerter.alerts.map((a) => a.key)).toEqual([ALERT_KEY_REFRESH]);
    expect(deps.alerter.alerts[0]?.message).toContain("serving 2 cached proxies");
  });

  test("network errors, bad JSON and an empty list are failures too", async () => {
    const { deps, pool } = setup();
    deps.fetch.enqueue({ json: websharePage(["1"]) });
    await pool.refresh();
    deps.fetch.enqueue(new TypeError("connect ECONNREFUSED"));
    expect(await pool.refresh()).toBe(false);
    deps.fetch.enqueue({ body: "<html>", headers: { "content-type": "text/html" } });
    expect(await pool.refresh()).toBe(false);
    deps.fetch.enqueue({ json: { results: "nope" } });
    expect(await pool.refresh()).toBe(false);
    deps.fetch.enqueue({ json: websharePage([]) });
    expect(await pool.refresh()).toBe(false);
    expect(pool.health().total).toBe(1);
  });

  test("pagination never sends the token off-site", async () => {
    const { deps, pool } = setup();
    deps.fetch.enqueue({ json: websharePage(["1"], "https://evil.example/steal") });
    expect(await pool.refresh()).toBe(false);
    expect(deps.fetch.calls).toHaveLength(1);
    expect(pool.health().lastRefreshError).toContain("off-site");
  });

  test("refresh is single-flight", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["1"]) }));
    await Promise.all([pool.refresh(), pool.refresh(), pool.ready()]);
    expect(deps.fetch.calls).toHaveLength(1);
  });
});

describe("ready", () => {
  test("loads once, then only when the hourly job is late", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["1"]) }));
    await pool.ready();
    await pool.ready();
    expect(deps.fetch.calls).toHaveLength(1);
    deps.clock.advance(REFRESH_INTERVAL_MS);
    await pool.ready();
    expect(deps.fetch.calls).toHaveLength(1);
    deps.clock.advance(READY_GRACE_MS);
    await pool.ready();
    expect(deps.fetch.calls).toHaveLength(2);
  });

  test("after a failure, retries after a short delay rather than on every call", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ status: 500 }));
    await pool.ready();
    await pool.ready();
    expect(deps.fetch.calls).toHaveLength(1);
    deps.clock.advance(REFRESH_RETRY_MS);
    await pool.ready();
    expect(deps.fetch.calls).toHaveLength(2);
    // Never loaded: fail closed.
    expect(noProxy(() => pool.assign(1, null)).kind).toBe("no_proxy");
  });
});

describe("health and cooldowns", () => {
  test("cooldown doubles from 2 min and caps at 2 h", () => {
    expect(cooldownFor(1)).toBe(COOLDOWN_MIN_MS);
    expect(cooldownFor(2)).toBe(2 * COOLDOWN_MIN_MS);
    expect(cooldownFor(3)).toBe(4 * COOLDOWN_MIN_MS);
    expect(cooldownFor(6)).toBe(64 * MIN);
    expect(cooldownFor(7)).toBe(COOLDOWN_MAX_MS);
    expect(cooldownFor(500)).toBe(COOLDOWN_MAX_MS);
  });

  test("a failed proxy is skipped until its cooldown ends; a success resets it", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["a", "b", "c", "d"]) }));
    await pool.ready();
    pool.reportFailure("a", "network");
    expect(pool.health().healthy).toBe(3);
    expect(pool.assign(1, "a")?.key).not.toBe("a");

    deps.clock.advance(COOLDOWN_MIN_MS);
    expect(pool.assign(1, "a")?.key).toBe("a");
    // The second consecutive failure doubles the cooldown.
    pool.reportFailure("a", "network");
    deps.clock.advance(COOLDOWN_MIN_MS);
    expect(pool.assign(1, "a")?.key).not.toBe("a");
    deps.clock.advance(COOLDOWN_MIN_MS);
    expect(pool.assign(1, "a")?.key).toBe("a");

    pool.reportSuccess("a");
    pool.reportFailure("a", "network");
    deps.clock.advance(COOLDOWN_MIN_MS);
    expect(pool.health().healthy).toBe(4);
  });

  test("health is keyed by proxy id and survives refreshes; gone proxies are forgotten", async () => {
    const { deps, pool } = setup();
    let ids = ["a", "b", "c"];
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(ids) }));
    await pool.refresh();
    pool.reportFailure("a", "edge_block");
    // Reordered (so URLs and positions change) but "a" is still in cooldown.
    ids = ["c", "b", "a"];
    await pool.refresh();
    expect(pool.health()).toMatchObject({ total: 3, healthy: 2 });
    // "a" leaves and comes back: its record was dropped.
    ids = ["b", "c"];
    await pool.refresh();
    ids = ["a", "b", "c"];
    await pool.refresh();
    expect(pool.health().healthy).toBe(3);
  });

  test("reports for unknown proxies are ignored", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["a"]) }));
    await pool.ready();
    pool.reportFailure("zzz", "network");
    pool.reportSuccess("zzz");
    expect(pool.health().healthy).toBe(1);
  });

  test("alerts when fewer than half are healthy", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["a", "b", "c", "d"]) }));
    await pool.ready();
    pool.reportFailure("a", "network");
    pool.reportFailure("b", "network");
    expect(deps.alerter.alerts).toEqual([]);
    pool.reportFailure("c", "network");
    await Promise.resolve();
    expect(deps.alerter.alerts.map((a) => a.key)).toEqual([ALERT_KEY_UNHEALTHY]);
    expect(deps.alerter.alerts[0]?.message).toContain("1/4 healthy");
    expect(deps.metrics.get("reddit.proxies.healthy")).toBe(1);
    expect(deps.metrics.get("reddit.proxies.total")).toBe(4);
  });

  test("fails closed when none are healthy", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["a", "b"]) }));
    await pool.ready();
    pool.reportFailure("a", "network");
    pool.reportFailure("b", "rate_limited");
    const err = noProxy(() => pool.assign(1, "a"));
    expect(err.kind).toBe("no_proxy");
    expect(err.message).toContain("0/2");
    expect(noProxy(() => pool.assign(1, null, "a")).kind).toBe("no_proxy");
  });
});

describe("assign", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);

  async function loaded() {
    const s = setup();
    let list = ids;
    s.deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(list) }));
    await s.pool.refresh();
    return { ...s, setList: (next: string[]) => (list = next) };
  }

  test("rendezvous: stable per account, spread across proxies", async () => {
    const { pool } = await loaded();
    const picks = new Map<number, string>();
    for (let account = 1; account <= 200; account++) {
      const key = pool.assign(account, null)?.key ?? "";
      expect(pool.assign(account, null)?.key).toBe(key);
      picks.set(account, key);
    }
    expect(new Set(picks.values()).size).toBeGreaterThan(15);
  });

  test("keeps the current key while healthy, even if rendezvous would pick another", async () => {
    const { pool } = await loaded();
    const natural = pool.assign(42, null)?.key;
    const other = ids.find((k) => k !== natural) ?? "";
    expect(pool.assign(42, other)?.key).toBe(other);
  });

  test("an unknown current key is replaced by the rendezvous pick", async () => {
    const { pool } = await loaded();
    expect(pool.assign(42, "gone")?.key).toBe(pool.assign(42, null)?.key ?? "");
  });

  test("removing a proxy only moves the accounts that were on it", async () => {
    const { pool, setList } = await loaded();
    const before = new Map<number, string>();
    for (let account = 1; account <= 200; account++) {
      before.set(account, pool.assign(account, null)?.key ?? "");
    }
    const removed = "p3";
    setList(ids.filter((k) => k !== removed));
    await pool.refresh();
    for (const [account, key] of before) {
      const now = pool.assign(account, null)?.key;
      if (key === removed) expect(now).not.toBe(removed);
      else expect(now).toBe(key);
    }
  });

  test("an unhealthy current key falls back to the next rendezvous choice", async () => {
    const { pool } = await loaded();
    const first = pool.assign(9, null)?.key ?? "";
    pool.reportFailure(first, "edge_block");
    const second = pool.assign(9, first)?.key;
    expect(second).not.toBe(first);
    expect(second).toBe(
      rendezvousPick(
        9,
        ids.filter((k) => k !== first),
      ) ?? "",
    );
  });

  test("avoidKey prefers another healthy proxy, but uses it if it's the only one", async () => {
    const { pool } = await loaded();
    const current = pool.assign(3, null)?.key ?? "";
    expect(pool.assign(3, current, current)?.key).not.toBe(current);

    const single = setup();
    single.deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["only"]) }));
    await single.pool.ready();
    expect(single.pool.assign(3, "only", "only")?.key).toBe("only");
  });
});

describe("disabled (no WEBSHARE_TOKEN)", () => {
  test("assign returns null, nothing is fetched", async () => {
    const { deps, pool } = setup(null);
    expect(pool.enabled).toBe(false);
    await pool.ready();
    expect(await pool.refresh()).toBe(true);
    expect(pool.assign(1, "x")).toBeNull();
    expect(deps.fetch.calls).toHaveLength(0);
    expect(pool.health()).toEqual({
      configured: false,
      total: 0,
      healthy: 0,
      lastRefreshAt: null,
      lastRefreshError: null,
    });
  });

  test("an empty token counts as unset", () => {
    expect(setup("").pool.enabled).toBe(false);
  });
});

describe("rendezvousPick", () => {
  test("empty list is undefined; deterministic otherwise", () => {
    expect(rendezvousPick(1, [])).toBeUndefined();
    expect(rendezvousPick(1, ["a", "b", "c"])).toBe(rendezvousPick(1, ["c", "b", "a"]) ?? "");
  });
});

describe("review regressions", () => {
  test("failures reported while a proxy is already cooling down don't stack doublings", async () => {
    const { deps, pool } = setup();
    deps.fetch.on("GET", WEBSHARE, () => ({ json: websharePage(["a", "b"]) }));
    await pool.ready();
    // A burst of in-flight requests on "a" all time out at once.
    for (let i = 0; i < 7; i++) pool.reportFailure("a", "network");
    expect(deps.metrics.get("reddit.proxies.failures")).toBe(7);
    deps.clock.advance(COOLDOWN_MIN_MS - 1);
    expect(pool.health().healthy).toBe(1);
    deps.clock.advance(1);
    expect(pool.health().healthy).toBe(2);
    // Half-open: the next failure is the second step (4 min), not the eighth.
    pool.reportFailure("a", "network");
    deps.clock.advance(2 * COOLDOWN_MIN_MS);
    expect(pool.health().healthy).toBe(2);
  });

  test("with a list loaded, ready() doesn't wait for an in-flight refresh", async () => {
    const { deps, pool } = setup();
    const webshare = Promise.withResolvers<Response>();
    deps.fetch.enqueue({ json: websharePage(["a"]) });
    deps.fetch.enqueue(() => webshare.promise);
    await pool.refresh();
    const refreshing = pool.refresh();
    let done = false;
    await pool.ready().then(() => (done = true));
    expect(done).toBe(true);
    expect(pool.assign(1, null)?.key).toBe("a");
    webshare.resolve(Response.json(websharePage(["a", "b"])));
    expect(await refreshing).toBe(true);
    expect(pool.health().total).toBe(2);
  });

  test("with a list loaded, a due refresh runs in the background", async () => {
    const { deps, pool } = setup();
    const webshare = Promise.withResolvers<Response>();
    deps.fetch.enqueue({ json: websharePage(["a"]) });
    deps.fetch.enqueue(() => webshare.promise);
    await pool.ready();
    deps.clock.advance(REFRESH_INTERVAL_MS + READY_GRACE_MS);
    await pool.ready();
    // Started, not awaited.
    expect(deps.fetch.calls).toHaveLength(2);
    expect(pool.assign(1, null)?.key).toBe("a");
    // Joining it later doesn't start another.
    await pool.ready();
    expect(deps.fetch.calls).toHaveLength(2);
    webshare.resolve(Response.json(websharePage(["b"])));
    await pool.refresh();
    expect(pool.assign(1, null)?.key).toBe("b");
  });

  test("a pool that never loaded waits for the refresh", async () => {
    const { deps, pool } = setup();
    const webshare = Promise.withResolvers<Response>();
    deps.fetch.enqueue(() => webshare.promise);
    let done = false;
    const waiting = pool.ready().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    webshare.resolve(Response.json(websharePage(["a"])));
    await waiting;
    expect(pool.assign(1, null)?.key).toBe("a");
  });

  test("a failed refresh doesn't wait for the alert to be delivered", async () => {
    const deps = redditDeps();
    const pool = createProxyPool({
      ...deps,
      alerter: { alert: () => new Promise<void>(() => {}) },
      config: { webshareToken: "tok" },
    });
    deps.fetch.enqueue({ status: 503 });
    expect(await pool.refresh()).toBe(false);
  });
});
