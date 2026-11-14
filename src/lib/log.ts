import type { LogLevel } from "../config";
import { describeThrown } from "./errors";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Receives each JSON line (without the newline). Defaults to stdout. */
  sink?: (line: string) => void;
  base?: LogFields;
}

const MAX_CAUSE_DEPTH = 8;

/**
 * Errors don't survive JSON.stringify; turn them into plain objects. Follows
 * `cause` chains with a cycle guard and a depth limit.
 */
export function serializeError(err: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (!(err instanceof Error)) return err;
  if (seen.has(err)) return "[Circular]";
  seen.add(err);
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  if (err.stack) out["stack"] = err.stack;
  if (err.cause !== undefined) {
    out["cause"] =
      depth >= MAX_CAUSE_DEPTH
        ? "[cause chain too deep]"
        : serializeError(err.cause, seen, depth + 1);
  }
  return out;
}

/** A JSON.stringify replacer for one call: Errors, bigints, and "[Circular]" for repeated objects. */
function makeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    const v = value instanceof Error ? serializeError(value) : value;
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
    }
    return v;
  };
}

/**
 * The fallback when the whole entry can't be serialized: keep every field
 * that can be, and replace the others with a short description.
 */
function serializeFieldByField(entry: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    try {
      JSON.stringify(value, makeReplacer());
      safe[key] = value;
    } catch {
      safe[key] = `[unserializable: ${describeThrown(value)}]`;
    }
  }
  try {
    return JSON.stringify(safe, makeReplacer());
  } catch {
    return JSON.stringify({ ts: entry["ts"], level: entry["level"], msg: String(entry["msg"]) });
  }
}

const stdoutSink = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** A JSON-lines logger: one object per line with `ts`, `level` and `msg`. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVELS[options.level ?? "info"];
  const sink = options.sink ?? stdoutSink;
  const base = options.base ?? {};

  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVELS[level] < min) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...base, ...fields };
    let line: string;
    try {
      line = JSON.stringify(entry, makeReplacer());
    } catch {
      line = serializeFieldByField(entry);
    }
    sink(line);
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
