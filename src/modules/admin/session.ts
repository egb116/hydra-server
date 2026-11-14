import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../../lib/clock";
import { digestEquals } from "../../lib/crypto";

export const SESSION_COOKIE = "hydra_admin";
/** Sessions last 12 hours. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Passwords longer than this are rejected without hashing (the real one is far shorter). */
export const MAX_PASSWORD_INPUT_CHARS = 1024;

const COOKIE_RE = /^(\d{1,16})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/;

export interface AdminSessions {
  /** Timing-safe comparison of SHA-256 digests. */
  checkPassword(input: string): boolean;
  /** A new signed session cookie value. */
  issue(): { value: string; maxAgeSec: number };
  /** True when the value is a session signed with the current key that has not expired or been revoked. */
  verify(value: string | undefined): boolean;
  /** Revokes every session issued up to now (in memory, so until the next restart). */
  revokeAll(): void;
}

function sha256(data: string): Buffer {
  return createHash("sha256").update(data, "utf8").digest();
}

/**
 * Stateless admin sessions. The cookie is `<iat>.<exp>.<sig>`, where sig is
 * HMAC-SHA256 over `<iat>.<exp>` with the session key
 * `HMAC-SHA256(ENCRYPTION_KEY bytes, 'admin:' + hex(sha256(DASHBOARD_PASSWORD)))`.
 * Changing either the password or the encryption key invalidates every session.
 */
export function createAdminSessions(options: {
  encryptionKey: string;
  password: string;
  clock: Clock;
  ttlMs?: number;
}): AdminSessions {
  const { clock } = options;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const passwordDigest = sha256(options.password);
  const sessionKey = createHmac("sha256", Buffer.from(options.encryptionKey, "hex"))
    .update(`admin:${passwordDigest.toString("hex")}`, "utf8")
    .digest();
  /** Sessions issued at or before this instant are invalid (logout). */
  let revokedThrough = -1;

  const sign = (payload: string): Buffer =>
    createHmac("sha256", sessionKey).update(payload, "utf8").digest();

  return {
    checkPassword(input) {
      if (input.length > MAX_PASSWORD_INPUT_CHARS) return false;
      return digestEquals(input, options.password);
    },
    issue() {
      const iat = Math.max(clock.now(), revokedThrough + 1);
      const exp = iat + ttlMs;
      const payload = `${iat}.${exp}`;
      return {
        value: `${payload}.${sign(payload).toString("base64url")}`,
        maxAgeSec: Math.floor(ttlMs / 1000),
      };
    },
    verify(value) {
      if (value === undefined) return false;
      const match = COOKIE_RE.exec(value);
      if (!match) return false;
      const [, iatText = "", expText = "", sigText = ""] = match;
      const given = Buffer.from(sigText, "base64url");
      const expected = sign(`${iatText}.${expText}`);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
      const iat = Number(iatText);
      const exp = Number(expText);
      return iat > revokedThrough && exp > clock.now();
    },
    revokeAll() {
      revokedThrough = Math.max(revokedThrough, clock.now());
    },
  };
}
