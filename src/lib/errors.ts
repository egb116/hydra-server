/** Statuses an AppError can carry (all have a body, so Hono's c.json accepts them). */
export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503 | 504;

export interface AppErrorOptions {
  /** Machine-readable code for the JSON envelope. */
  code?: string;
  /** Extra data for the JSON envelope, for example zod issues. */
  details?: unknown;
  cause?: unknown;
}

/** An error with an HTTP status. The app's onError turns it into a response. */
export class AppError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(
    readonly status: AppErrorStatus,
    defaultCode: string,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? defaultCode;
    this.details = options.details;
  }
}

export class BadRequest extends AppError {
  constructor(message = "Bad request", options?: AppErrorOptions) {
    super(400, "bad_request", message, options);
  }
}

export class Forbidden extends AppError {
  constructor(message = "Forbidden", options?: AppErrorOptions) {
    super(403, "forbidden", message, options);
  }
}

export class NotFound extends AppError {
  constructor(message = "Not found", options?: AppErrorOptions) {
    super(404, "not_found", message, options);
  }
}

export class TooManyRequests extends AppError {
  /** Seconds, sent as the Retry-After header when set. */
  readonly retryAfter: number | undefined;

  constructor(message = "Too many requests", options?: AppErrorOptions & { retryAfter?: number }) {
    super(429, "too_many_requests", message, options);
    this.retryAfter =
      options?.retryAfter === undefined ? undefined : Math.max(1, Math.ceil(options.retryAfter));
  }
}

export class Upstream extends AppError {
  constructor(message = "Upstream error", options?: AppErrorOptions) {
    super(502, "upstream", message, options);
  }
}

export class Unavailable extends AppError {
  constructor(message = "Service unavailable", options?: AppErrorOptions) {
    super(503, "unavailable", message, options);
  }
}

const DESCRIBE_MAX_CHARS = 500;

/**
 * A short description (at most 500 chars) of any thrown value that never
 * throws itself, even for null-prototype objects, cycles, or values whose
 * toString / toPrimitive throws.
 */
export function describeThrown(value: unknown): string {
  const text = describeUnbounded(value);
  return text.length > DESCRIBE_MAX_CHARS ? `${text.slice(0, DESCRIBE_MAX_CHARS - 1)}…` : text;
}

function describeUnbounded(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null) {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    }
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unprintable value]";
    }
  }
}

/** Errors pass through; anything else is wrapped (the original is kept as `cause`). */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(`Non-Error thrown: ${describeThrown(value)}`, { cause: value });
}
