import { z } from "zod";
import type { Config } from "../../config";
import type { Alerter } from "../../lib/alert";
import type { Clock } from "../../lib/clock";
import { describeThrown } from "../../lib/errors";
import { drain, type OutboundFetch } from "../../lib/http";
import type { Logger } from "../../lib/log";
import type { Metrics } from "../../lib/metrics";
import { type ProxyHealthSnapshot, type ProxyPool, RedditError } from "../contracts";

/**
 * The Webshare proxy pool:
 * - the list is refreshed hourly; a failed refresh keeps serving the last good list and alerts;
 * - health is per proxy id and survives refreshes: consecutive failures and an
 *   exponential cooldown from 2 min to 2 h;
 * - accounts are pinned to a proxy by rendezvous hashing (sticky persona);
 * - when enabled it never hands out "no proxy": with none healthy it throws
 *   RedditError("no_proxy"), so a request never goes out from the server's own IP.
 */

export const WEBSHARE_LIST_URL =
  "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100";
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** After a failed refresh, ready() tries again this soon (the hourly job keeps its cadence). */
export const REFRESH_RETRY_MS = 60 * 1000;
/** ready() refreshes a list this much older than the interval (the job missed its slot). */
export const READY_GRACE_MS = 10 * 60 * 1000;
export const COOLDOWN_MIN_MS = 2 * 60 * 1000;
export const COOLDOWN_MAX_MS = 2 * 60 * 60 * 1000;
/** Below this fraction of healthy proxies, alert. */
export const HEALTHY_ALERT_FRACTION = 0.5;
const WEBSHARE_TIMEOUT_MS = 15_000;
/** 100 per page; a runaway `next` chain stops here. */
const MAX_PAGES = 100;

export const ALERT_KEY_REFRESH = "reddit:proxy-refresh";
export const ALERT_KEY_UNHEALTHY = "reddit:proxy-unhealthy";

export interface ProxyPoolDeps {
  config: Pick<Config, "webshareToken">;
  fetch: OutboundFetch;
  clock: Clock;
  log: Logger;
  alerter: Alerter;
  metrics: Metrics;
}

/** ProxyPool plus the refresh the module's hourly job runs. */
export interface RefreshableProxyPool extends ProxyPool {
  /**
   * Reloads the list from Webshare now (single-flight). Never throws: on
   * failure it keeps the last good list, records the error, logs and alerts,
   * and returns false.
   */
  refresh(): Promise<boolean>;
}

interface ProxyEntry {
  key: string;
  url: string;
}

interface ProxyHealth {
  consecutiveFailures: number;
  /** Unhealthy until this epoch ms. 0 = healthy. */
  cooldownUntil: number;
  lastFailure: string | null;
}

const webshareItem = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  username: z.string().min(1),
  password: z.string().min(1),
  proxy_address: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  valid: z.boolean().optional(),
});

const webshareList = z.object({
  next: z.string().nullable().optional(),
  results: z.array(z.unknown()),
});

/** The cooldown after the n-th consecutive failure (n >= 1). */
export function cooldownFor(consecutiveFailures: number): number {
  const exp = Math.max(0, consecutiveFailures - 1);
  // Cap the exponent so 2 ** exp never overflows into Infinity * 0 territory.
  return Math.min(COOLDOWN_MIN_MS * 2 ** Math.min(exp, 30), COOLDOWN_MAX_MS);
}

/** cyrb53: a fast, well-mixed 53-bit string hash (not cryptographic). */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Highest-random-weight choice: stable per account, and only accounts on a removed proxy move. */
export function rendezvousPick(accountId: number, keys: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const key of keys) {
    const score = hash53(`${accountId}:${key}`);
    if (score > bestScore || (score === bestScore && best !== undefined && key < best)) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

export function createProxyPool(deps: ProxyPoolDeps): RefreshableProxyPool {
  const token = deps.config.webshareToken;
  const enabled = token !== null && token !== "";
  const log = deps.log.child({ component: "proxyPool" });

  let proxies: ProxyEntry[] = [];
  const byKey = new Map<string, ProxyEntry>();
  const health = new Map<string, ProxyHealth>();
  let lastRefreshAt: number | null = null;
  let lastRefreshError: string | null = null;
  let nextRefreshAt = 0;
  let inFlight: Promise<boolean> | null = null;

  const isHealthy = (key: string, now: number): boolean => {
    const h = health.get(key);
    return h === undefined || h.cooldownUntil <= now;
  };

  const healthyKeys = (now: number): string[] =>
    proxies.filter((p) => isHealthy(p.key, now)).map((p) => p.key);

  const updateGauges = (now: number): { total: number; healthy: number } => {
    const total = proxies.length;
    const healthy = healthyKeys(now).length;
    deps.metrics.set("reddit.proxies.total", total);
    deps.metrics.set("reddit.proxies.healthy", healthy);
    return { total, healthy };
  };

  const checkHealthyFraction = (now: number): void => {
    const { total, healthy } = updateGauges(now);
    if (total === 0 || healthy / total >= HEALTHY_ALERT_FRACTION) return;
    const pct = (((total - healthy) / total) * 100).toFixed(1);
    void deps.alerter.alert(
      ALERT_KEY_UNHEALTHY,
      `${pct}% of proxies are unhealthy (${healthy}/${total} healthy).`,
    );
  };

  const loadList = async (): Promise<ProxyEntry[]> => {
    const entries: ProxyEntry[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    let nextUrl: string | null = WEBSHARE_LIST_URL;
    for (let page = 0; nextUrl !== null; page++) {
      if (page >= MAX_PAGES) throw new Error(`Webshare listing exceeded ${MAX_PAGES} pages`);
      // Never send the token anywhere but Webshare's API.
      const url = new URL(nextUrl, WEBSHARE_LIST_URL);
      if (url.protocol !== "https:" || url.hostname !== "proxy.webshare.io") {
        throw new Error(`Webshare pagination pointed off-site: ${url.origin}`);
      }
      const res = await deps.fetch(url, {
        method: "GET",
        headers: { Authorization: `Token ${token ?? ""}` },
        timeoutMs: WEBSHARE_TIMEOUT_MS,
      });
      if (!res.ok) {
        await drain(res);
        throw new Error(`Webshare proxy list failed: [${res.status}]`);
      }
      const parsed = webshareList.safeParse(await res.json());
      if (!parsed.success) throw new Error("Webshare proxy list had an unexpected shape");
      for (const raw of parsed.data.results) {
        const item = webshareItem.safeParse(raw);
        if (!item.success || item.data.valid === false || seen.has(item.data.id)) {
          skipped++;
          continue;
        }
        const p = item.data;
        seen.add(p.id);
        entries.push({
          key: p.id,
          url: `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.proxy_address}:${p.port}`,
        });
      }
      nextUrl = parsed.data.next ?? null;
    }
    if (entries.length === 0) throw new Error("Webshare returned no usable proxies");
    if (skipped > 0) log.warn("skipped unusable webshare proxies", { skipped });
    return entries;
  };

  const doRefresh = async (): Promise<boolean> => {
    const started = deps.clock.now();
    try {
      const fresh = await loadList();
      const now = deps.clock.now();
      proxies = fresh;
      byKey.clear();
      for (const p of fresh) byKey.set(p.key, p);
      // Health survives refreshes; forget proxies that are gone.
      for (const key of health.keys()) if (!byKey.has(key)) health.delete(key);
      lastRefreshAt = now;
      lastRefreshError = null;
      // The hourly job is the primary trigger; ready() only steps in when it is late.
      nextRefreshAt = now + REFRESH_INTERVAL_MS + READY_GRACE_MS;
      deps.metrics.inc("reddit.proxies.refreshes");
      log.info("proxy list refreshed", { total: fresh.length, ms: now - started });
      checkHealthyFraction(now);
      return true;
    } catch (err) {
      const now = deps.clock.now();
      lastRefreshError = describeThrown(err);
      nextRefreshAt = now + REFRESH_RETRY_MS;
      deps.metrics.inc("reddit.proxies.refreshFailures");
      log.error("proxy list refresh failed", { err, servingStale: proxies.length });
      // Not awaited: a slow alert webhook must not hold up anyone joining this refresh.
      void deps.alerter.alert(
        ALERT_KEY_REFRESH,
        `Webshare proxy refresh failed (serving ${proxies.length} cached proxies): ${lastRefreshError}`,
      );
      return false;
    }
  };

  const refresh = (): Promise<boolean> => {
    if (!enabled) return Promise.resolve(true);
    inFlight ??= doRefresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    enabled,

    async ready() {
      if (!enabled) return;
      if (!inFlight && deps.clock.now() < nextRefreshAt) return;
      // Start a due refresh, or join the one in flight. With a list already
      // loaded it runs in the background and the stale list keeps serving;
      // only a pool that has never loaded waits for it.
      const refreshing = refresh();
      if (proxies.length === 0) await refreshing;
    },

    refresh,

    assign(accountId, currentKey, avoidKey = null) {
      if (!enabled) return null;
      const now = deps.clock.now();
      if (
        currentKey !== null &&
        currentKey !== avoidKey &&
        byKey.has(currentKey) &&
        isHealthy(currentKey, now)
      ) {
        const kept = byKey.get(currentKey);
        if (kept) return { key: kept.key, url: kept.url };
      }
      const healthy = healthyKeys(now);
      const preferred = healthy.filter((k) => k !== avoidKey);
      const key = rendezvousPick(accountId, preferred.length > 0 ? preferred : healthy);
      const entry = key === undefined ? undefined : byKey.get(key);
      if (!entry) {
        deps.metrics.inc("reddit.proxies.noProxy");
        throw new RedditError(
          "no_proxy",
          proxies.length === 0
            ? "No proxies loaded (Webshare list unavailable)"
            : `No healthy proxies (0/${proxies.length})`,
        );
      }
      return { key: entry.key, url: entry.url };
    },

    reportSuccess(key) {
      const h = health.get(key);
      if (h === undefined) return;
      health.delete(key);
      if (h.cooldownUntil > 0) updateGauges(deps.clock.now());
    },

    reportFailure(key, reason) {
      if (!byKey.has(key)) return;
      const now = deps.clock.now();
      const h = health.get(key) ?? { consecutiveFailures: 0, cooldownUntil: 0, lastFailure: null };
      h.lastFailure = reason;
      health.set(key, h);
      deps.metrics.inc("reddit.proxies.failures");
      if (h.cooldownUntil > now) {
        // Half-open: only a failure while the proxy is in use is a new step. These
        // are requests that were already in flight when it was benched, and they
        // must not stack doublings (a burst of timeouts would jump to the 2 h cap).
        return;
      }
      h.consecutiveFailures++;
      h.cooldownUntil = now + cooldownFor(h.consecutiveFailures);
      log.debug("proxy marked unhealthy", {
        proxyKey: key,
        reason,
        consecutiveFailures: h.consecutiveFailures,
        cooldownMs: h.cooldownUntil - now,
      });
      checkHealthyFraction(now);
    },

    health(): ProxyHealthSnapshot {
      const now = deps.clock.now();
      return {
        configured: enabled,
        total: proxies.length,
        healthy: healthyKeys(now).length,
        lastRefreshAt,
        lastRefreshError,
      };
    },
  };
}
