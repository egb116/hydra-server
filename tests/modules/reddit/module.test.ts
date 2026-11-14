import { describe, expect, test } from "bun:test";
import { JobRunner } from "../../../src/lib/jobs";
import {
  createProxyPool,
  createRedditModule,
  PROXY_REFRESH_JOB,
} from "../../../src/modules/reddit";
import { redditDeps, websharePage } from "./helpers";

function setup(token: string | null) {
  const deps = redditDeps();
  const pool = createProxyPool({ ...deps, config: { webshareToken: token } });
  const runner = new JobRunner(deps);
  const module = createRedditModule(pool);
  module.jobs?.(runner);
  return { deps, pool, runner, module };
}

describe("createRedditModule", () => {
  test("registers the hourly refresh job when enabled", async () => {
    const { deps, runner, module } = setup("tok");
    expect(module.name).toBe("reddit");
    expect(Object.keys(runner.heartbeats())).toEqual([PROXY_REFRESH_JOB]);

    deps.fetch.on("GET", "https://proxy.webshare.io/", () => ({ json: websharePage(["a", "b"]) }));
    expect(await runner.runNow(PROXY_REFRESH_JOB)).toBe(true);
    expect(runner.heartbeats()[PROXY_REFRESH_JOB]?.lastError).toBeNull();
    expect(module.health?.()).toEqual({
      ok: true,
      detail: {
        configured: true,
        total: 2,
        healthy: 2,
        lastRefreshAt: deps.clock.now(),
        lastRefreshError: null,
        degraded: false,
      },
    });
    await runner.stopAll();
  });

  test("a failed refresh shows in the job heartbeat; health stays ok but degraded", async () => {
    const { deps, runner, module } = setup("tok");
    deps.fetch.on("GET", "https://proxy.webshare.io/", () => ({ status: 401 }));
    await runner.runNow(PROXY_REFRESH_JOB);
    expect(runner.heartbeats()[PROXY_REFRESH_JOB]?.lastError).toContain("401");
    const health = module.health?.();
    expect(health?.ok).toBe(true);
    expect(health?.detail).toMatchObject({ degraded: true, total: 0 });
    await runner.stopAll();
  });

  test("disabled: no job, not degraded", async () => {
    const { runner, module } = setup(null);
    expect(Object.keys(runner.heartbeats())).toEqual([]);
    expect(module.health?.()).toMatchObject({
      ok: true,
      detail: { configured: false, degraded: false },
    });
    await runner.stopAll();
  });
});
