/**
 * The only place external HTTP happens. Everything else takes an
 * `OutboundFetch` so tests can inject a fake.
 */

export interface OutboundInit extends Omit<RequestInit, "signal"> {
  /** Required: every outbound request has a deadline. */
  timeoutMs: number;
  /** Proxy URL (http(s)://user:pass@host:port). Omit to go direct. */
  proxy?: string;
  /** Aborts the request early, in addition to the timeout. */
  signal?: AbortSignal;
}

export type OutboundFetch = (url: string | URL, init: OutboundInit) => Promise<Response>;

/** Wraps Bun's fetch with a timeout and the per-request `proxy` option. */
export function createOutboundFetch(base: typeof fetch = fetch): OutboundFetch {
  return (url, init) => {
    const { timeoutMs, proxy, signal, ...rest } = init;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return base(url, {
      ...rest,
      signal: combined,
      ...(proxy === undefined ? {} : { proxy }),
    });
  };
}

/** True when an error came from an abort or a timeout signal. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Discards a response body we won't read, so the connection can be reused. */
export async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/** A JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
