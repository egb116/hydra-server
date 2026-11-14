import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { clientIp, clientNetworkKey } from "../../http/clientIp";
import { TokenBucket } from "../../lib/limiter";
import type { App, AppEnv, Deps, Module } from "../../types";
import { renderDashboard, renderLogin } from "./render";
import { type AdminSessions, createAdminSessions, SESSION_COOKIE } from "./session";
import { type AdminSources, createStatsCollector, type StatsCollector } from "./stats";

/** Login attempts allowed per client IP per minute. */
export const LOGIN_ATTEMPTS_PER_MINUTE = 5;

const LOGIN_PATH = "/admin/login";

/** Headers on every /admin response. Pages with inline code replace the CSP with a nonce one. */
const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const DEFAULT_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", DEFAULT_CSP);
}

function isApiPath(path: string): boolean {
  return path === "/admin/api" || path.startsWith("/admin/api/");
}

type TrustProxy = Deps["config"]["trustProxy"];

/**
 * Whether the browser reached us over https: the request URL itself, or a
 * trusted proxy's X-Forwarded-Proto (TRUST_PROXY).
 */
function isHttps(c: Context<AppEnv>, trustProxy: TrustProxy): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  if (trustProxy === "none") return false;
  return c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

function newNonce(): string {
  return randomBytes(16).toString("base64");
}

function htmlPage(
  c: Context<AppEnv>,
  render: (nonce: string) => string,
  status: 200 | 401 | 429 = 200,
): Response {
  const nonce = newNonce();
  c.header("Content-Security-Policy", pageCsp(nonce));
  return c.html(render(nonce), status);
}

/**
 * The /admin dashboard: cookie-session login, the server-rendered page and
 * GET /admin/api/stats. Returns a module without routes when
 * DASHBOARD_PASSWORD is not set (config already warned about it).
 */
export function createAdminModule(deps: Deps, sources: AdminSources): Module {
  const password = deps.config.dashboardPassword;
  if (password === null) return { name: "admin" };

  const sessions = createAdminSessions({
    encryptionKey: deps.config.encryptionKey,
    password,
    clock: deps.clock,
  });
  const loginLimiter = new TokenBucket({
    capacity: LOGIN_ATTEMPTS_PER_MINUTE,
    refillPerSecond: LOGIN_ATTEMPTS_PER_MINUTE / 60,
    clock: deps.clock,
  });
  const stats = createStatsCollector(deps, sources);

  return {
    name: "admin",
    routes: (app) => registerAdminRoutes(app, deps, { sessions, loginLimiter, stats }),
  };
}

interface AdminRouteServices {
  sessions: AdminSessions;
  loginLimiter: TokenBucket;
  stats: StatsCollector;
}

function registerAdminRoutes(app: App, deps: Deps, services: AdminRouteServices): void {
  const { sessions, loginLimiter, stats } = services;
  const authed = (c: Context<AppEnv>): boolean => sessions.verify(getCookie(c, SESSION_COOKIE));
  const cookieOptions = (c: Context<AppEnv>) =>
    ({
      path: "/admin",
      httpOnly: true,
      sameSite: "Strict",
      secure: isHttps(c, deps.config.trustProxy),
    }) as const;
  const logFor = (c: Context<AppEnv>) => c.get("log") ?? deps.log;

  // Security headers on everything under /admin, then the session gate
  // (everything except the login page itself).
  const gate: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.req.path !== LOGIN_PATH && !authed(c)) {
      const res = isApiPath(c.req.path)
        ? c.json({ error: { code: "unauthorized", message: "Not logged in" } }, 401)
        : c.redirect(LOGIN_PATH, 302);
      applySecurityHeaders(res.headers);
      return res;
    }
    await next();
    applySecurityHeaders(c.res.headers);
    return undefined;
  };
  app.use("/admin/*", gate);

  app.get(LOGIN_PATH, (c) => {
    if (authed(c)) return c.redirect("/admin", 302);
    return htmlPage(c, (nonce) => renderLogin(nonce));
  });

  app.post(LOGIN_PATH, async (c) => {
    const log = logFor(c);
    const ip = clientIp(c);
    // Keyed by network: one client controls a whole IPv6 /64.
    const take = loginLimiter.take(clientNetworkKey(ip));
    if (!take.ok) {
      log.warn("admin login rate limited", { ip });
      c.header("Retry-After", String(Math.max(1, Math.ceil(take.retryAfterMs / 1000))));
      return htmlPage(
        c,
        (nonce) => renderLogin(nonce, "Too many attempts. Try again in a minute."),
        429,
      );
    }
    let input = "";
    try {
      const form = await c.req.parseBody();
      const value = form["password"];
      if (typeof value === "string") input = value;
    } catch {
      // An unparseable body is just a failed attempt.
    }
    if (input === "" || !sessions.checkPassword(input)) {
      deps.metrics.inc("admin.login_failures");
      log.warn("admin login failed", { ip });
      return htmlPage(c, (nonce) => renderLogin(nonce, "Incorrect password."), 401);
    }
    const session = sessions.issue();
    setCookie(c, SESSION_COOKIE, session.value, { ...cookieOptions(c), maxAge: session.maxAgeSec });
    deps.metrics.inc("admin.logins");
    log.info("admin login", { ip });
    return c.redirect("/admin", 303);
  });

  app.post("/admin/logout", (c) => {
    // A cross-site post arrives without the SameSite=Strict cookie, so the
    // gate has already redirected it. Sessions are stateless, so logging out revokes every session issued
    // so far (there is one admin) until the next restart, and clears the cookie.
    sessions.revokeAll();
    deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
    logFor(c).info("admin logout", { ip: clientIp(c) });
    return c.redirect(LOGIN_PATH, 303);
  });

  app.get("/admin", (c) => htmlPage(c, (nonce) => renderDashboard(stats.collect(), nonce)));
  app.get("/admin/", (c) => c.redirect("/admin", 302));
  app.get("/admin/api/stats", (c) => c.json(stats.collect()));
}
