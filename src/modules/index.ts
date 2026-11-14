import type { Heartbeat } from "../lib/jobs";
import { secretBoxFromConfig } from "../lib/crypto";
import type { Deps, Module } from "../types";
import { createAdminModule } from "./admin";
import { createAiModule } from "./ai";
import { createEntitlementService, createEntitlementsModule } from "./entitlements";
import { createPoller, createPollerModule } from "./poller";
import { createPushModule, createPushService } from "./push";
import { createProxyPool, createRedditClient, createRedditModule } from "./reddit";
import { createRegistrationModule, pruneOrphanAccounts } from "./registration";

export interface CreateModulesOptions {
  /** The JobRunner's heartbeats, shown on /admin. main.ts passes its runner. */
  jobs?: { heartbeats(): Record<string, Heartbeat> };
}

/**
 * Builds the shared services in dependency order, then every feature module.
 *
 * The returned order is the start order; main.ts stops modules in reverse, so
 * the poller (which uses reddit and push) stops before push, and the
 * entitlements reconcile and the proxy pool stop last.
 */
export function createModules(deps: Deps, options: CreateModulesOptions = {}): Module[] {
  const secretBox = secretBoxFromConfig(deps.config);

  const proxyPool = createProxyPool(deps);
  const redditClient = createRedditClient(deps, proxyPool);
  const entitlements = createEntitlementService(deps);
  const push = createPushService(deps, { prune: pruneOrphanAccounts });
  const poller = createPoller(deps, { reddit: redditClient, push, secretBox });

  return [
    createRedditModule(proxyPool),
    createEntitlementsModule(entitlements),
    createRegistrationModule(deps, { entitlements, secretBox }),
    createPushModule(push),
    createPollerModule(poller),
    createAiModule(deps, { entitlements }),
    createAdminModule(deps, {
      heartbeats: () => options.jobs?.heartbeats() ?? {},
      proxyHealth: () => proxyPool.health(),
    }),
  ];
}
