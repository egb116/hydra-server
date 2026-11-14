import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { AppError, TooManyRequests, toError } from "../lib/errors";
import type { Logger } from "../lib/log";
import type { AppEnv, Deps } from "../types";
import { clientIp, resolveClientIp } from "./clientIp";

/** Exactly v1's middleware/cors.ts headers. */
export const LEGACY_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
} as const;

export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
/** Alert when more than this many 5xx responses happen within a minute. */
export const SERVER_ERROR_ALERT_THRESHOLD = 10;
const SERVER_ERROR_WINDOW_MS = 60_000;

const QUIET_PATHS = new Set(["/api/status", "/healthz"]);

/** The generic 500 body. Never includes internals. */
export function internalErrorBody(requestId: string | undefined): {
  error: { code: "internal"; message: string; requestId?: string };
} {
  return {
    error: {
      code: "internal",
      message: "Internal error",
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

/**
 * The app's onError: AppError → its status, HTTPException → its status,
 * anything else → a logged, generic 500. On the legacy text paths the body is
 * the bare message as text/plain; elsewhere it is the JSON envelope.
 */
export function errorHandler(deps: Pick<Deps, "log">): ErrorHandler<AppEnv> {
  return (err, c) => {
    const text = isLegacyTextErrorPath(c.req.path);
    if (err instanceof AppError) {
      const status = err.status;
      if (err instanceof TooManyRequests && err.retryAfter !== undefined) {
        c.header("Retry-After", String(err.retryAfter));
      }
      if (text) return c.text(err.message, status);
      const body: { code: string; message: string; details?: unknown } = {
        code: err.code,
        message: err.message,
      };
      if (err.details !== undefined) body.details = err.details;
      return c.json({ error: body }, status);
    }
    if (err instanceof HTTPException) {
      if (text) return c.text(err.message, err.status);
      return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    }
    const requestId = c.get("requestId");
    const log: Logger = c.get("log") ?? deps.log;
    log.error("unhandled error", { err, method: c.req.method, path: c.req.path });
    if (text) return c.text("Internal error", 500);
    return c.json(internalErrorBody(requestId), 500);
  };
}

/**
 * Assigns a request id (X-Request-Id), resolves the client IP, times the
 * request and writes one log line for it. Also counts 5xx responses and
 * alerts on a burst.
 *
 * Hono passes only `Error` instances to onError; a thrown string or a
 * rejection with a plain object propagates out of `next()`. Those are caught
 * here and answered by the same error handler, so every request gets a
 * request id, a log line and 5xx accounting.
 */
export function requestContext(
  deps: Pick<Deps, "log" | "clock" | "alerter" | "metrics" | "config">,
): MiddlewareHandler<AppEnv> {
  let recent5xx: number[] = [];
  const onError = errorHandler(deps);
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    const log = deps.log.child({ requestId });
    c.set("requestId", requestId);
    c.set("log", log);
    c.set(
      "clientIp",
      resolveClientIp((name) => c.req.header(name), c.env?.remoteAddr, deps.config.trustProxy),
    );
    const started = performance.now();
    try {
      await next();
    } catch (thrown) {
      c.res = await respondToError(onError, toError(thrown), c, log, requestId);
    }
    c.header("X-Request-Id", requestId);
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      ip: clientIp(c),
    };
    if (QUIET_PATHS.has(c.req.path)) log.debug("request", fields);
    else log.info("request", fields);
    deps.metrics.inc("http.requests");
    if (status >= 500) {
      deps.metrics.inc("http.5xx");
      const now = deps.clock.now();
      recent5xx = recent5xx.filter((t) => now - t < SERVER_ERROR_WINDOW_MS);
      recent5xx.push(now);
      if (recent5xx.length > SERVER_ERROR_ALERT_THRESHOLD) {
        void deps.alerter.alert(
          "http-5xx",
          `More than ${SERVER_ERROR_ALERT_THRESHOLD} HTTP 5xx responses in the last minute (latest: ${status} ${c.req.method} ${c.req.path}).`,
        );
      }
    }
  };
}

async function respondToError(
  onError: ErrorHandler<AppEnv>,
  err: Error,
  c: Context<AppEnv>,
  log: Logger,
  requestId: string,
): Promise<Response> {
  c.error = err;
  try {
    return await onError(err, c);
  } catch (handlerErr) {
    log.error("error handler failed", { err: handlerErr, original: err });
    return Response.json(internalErrorBody(requestId), { status: 500 });
  }
}

/**
 * Legacy routes whose errors (every status, including 413 and unexpected
 * 500s) are plain text, as in v1: app builds before 2026-08 show the summarize
 * routes' body as the summary, and every build reads filterPosts and
 * createEmbedding with response.json() without checking ok (APP:api/AI.ts),
 * so a JSON envelope would be misread as data.
 */
export function isLegacyTextErrorPath(path: string): boolean {
  return path.startsWith("/api/ai/");
}

/** Rejects bodies over `maxSize` bytes with a 413 (JSON, or text on the AI routes). */
export function bodyLimit(maxSize = DEFAULT_BODY_LIMIT_BYTES): MiddlewareHandler<AppEnv> {
  return honoBodyLimit({
    maxSize,
    onError: (c) =>
      isLegacyTextErrorPath(c.req.path)
        ? c.text("Request body too large", 413)
        : c.json({ error: { code: "payload_too_large", message: "Request body too large" } }, 413),
  });
}

/**
 * v1 answered OPTIONS on any /api/* path with 200, an empty body and the
 * CORS headers above. Mount on "/api/*".
 */
export const legacyCorsPreflight: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "OPTIONS") return next();
  return new Response(null, { status: 200, headers: LEGACY_CORS_HEADERS });
};
