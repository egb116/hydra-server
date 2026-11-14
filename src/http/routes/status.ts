import type { App, Deps, Module, ModuleHealth } from "../../types";
import { SERVER_VERSION } from "../../version";

export const STATUS_BODY = "Hydra server is up";
export const VERSION_HEADER = "X-Hydra-Server-Version";

/** GET /api/status (frozen app contract) and GET /healthz (Fly checks). */
export function registerStatusRoutes(
  app: App,
  deps: Pick<Deps, "sqlite" | "clock">,
  modules: readonly Module[],
): void {
  const startedAt = deps.clock.now();

  app.get("/api/status", (c) => {
    c.header(VERSION_HEADER, SERVER_VERSION);
    return c.text(STATUS_BODY, 200);
  });

  app.get("/healthz", (c) => {
    let dbOk = false;
    let dbError: string | undefined;
    try {
      dbOk = deps.sqlite.query<{ ok: number }, []>("SELECT 1 AS ok").get()?.ok === 1;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }
    const moduleHealth: Record<string, ModuleHealth> = {};
    for (const m of modules) {
      if (!m.health) continue;
      try {
        moduleHealth[m.name] = m.health();
      } catch (err) {
        moduleHealth[m.name] = {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const ok = dbOk && Object.values(moduleHealth).every((h) => h.ok);
    return c.json(
      {
        ok,
        version: SERVER_VERSION,
        uptimeSec: Math.floor((deps.clock.now() - startedAt) / 1000),
        db: dbError === undefined ? { ok: dbOk } : { ok: dbOk, error: dbError },
        modules: moduleHealth,
      },
      ok ? 200 : 503,
    );
  });
}
