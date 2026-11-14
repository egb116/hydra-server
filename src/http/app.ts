import { Hono } from "hono";
import type { App, AppEnv, Deps, Module } from "../types";
import { bodyLimit, errorHandler, legacyCorsPreflight, requestContext } from "./middleware";
import { registerStatusRoutes } from "./routes/status";

/** Builds the Hono app: global middleware, status routes, module routes, 404 and errors. */
export function buildApp(deps: Deps, modules: readonly Module[]): App {
  const app = new Hono<AppEnv>();

  app.use(requestContext(deps));
  app.use(bodyLimit());
  app.use("/api/*", legacyCorsPreflight);

  registerStatusRoutes(app, deps, modules);
  for (const module of modules) module.routes?.(app);

  app.notFound((c) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    }
    return c.text("Not found", 404);
  });

  app.onError(errorHandler(deps));

  return app;
}
