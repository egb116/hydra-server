import { isIP } from "node:net";
import type { Context } from "hono";
import type { TrustProxy } from "../config";
import type { AppEnv } from "../types";

const UNKNOWN = "unknown";

function validIp(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  // isIP rejects anything that isn't a bare IPv4/IPv6 address, which also
  // bounds the length of what ends up in limiter keys and logs.
  return trimmed.length <= 64 && isIP(trimmed) !== 0 ? trimmed : null;
}

/**
 * The client's IP. Proxy headers are client-controlled unless a trusted proxy
 * sets or appends them, so they are read only as configured (TRUST_PROXY):
 *
 * - `"none"`: the TCP peer address only.
 * - `"fly"`: `Fly-Client-IP`, which Fly's edge always overwrites.
 * - a hop count N: the N-th `X-Forwarded-For` entry from the right (each of
 *   the N trusted proxies appends the address it received from, so entries
 *   further left are whatever the client sent).
 *
 * A missing or invalid header value falls back to the peer address.
 */
export function resolveClientIp(
  header: (name: string) => string | undefined,
  remoteAddr: string | undefined,
  trust: TrustProxy,
): string {
  const peer = validIp(remoteAddr) ?? UNKNOWN;
  if (trust === "fly") return validIp(header("fly-client-ip")) ?? peer;
  if (typeof trust === "number") {
    const entries = (header("x-forwarded-for") ?? "").split(",");
    if (entries.length < trust) return peer;
    return validIp(entries[entries.length - trust]) ?? peer;
  }
  return peer;
}

/** The request's client IP, as resolved once by requestContext. */
export function clientIp(c: Context<AppEnv>): string {
  return c.get("clientIp") ?? validIp(c.env?.remoteAddr) ?? UNKNOWN;
}

// ------------------------------------------------------------ client network

/*
 * The key per-client limiters use. One client controls a whole IPv6 /64
 * (2^64 addresses), so keying by the full address would hand every request a
 * fresh bucket. IPv6 is therefore keyed by its /64 prefix, IPv4 by the full
 * address, and IPv4-mapped IPv6 (::ffff:a.b.c.d) as the IPv4 address it carries.
 */

const HEXTET = /^[0-9a-f]{1,4}$/;

function parseHextets(parts: string[]): number[] | null {
  const out: number[] = [];
  for (const part of parts) {
    if (!HEXTET.test(part)) return null;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

/** The 8 hextets of an IPv6 address, or null when it does not parse. */
export function expandIpv6(ip: string): number[] | null {
  let addr = ip.trim().toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // A dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two hextets.
  const lastColon = addr.lastIndexOf(":");
  const last = addr.slice(lastColon + 1);
  if (last.includes(".")) {
    const octets = last.split(".");
    if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets.map(Number);
    addr = `${addr.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? parseHextets(halves[0].split(":")) : [];
  const tail = halves.length === 2 && halves[1] ? parseHextets(halves[1].split(":")) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/**
 * The limiter key for a client IP: IPv4 unchanged, IPv6 as `<first 4
 * hextets>::/64`, IPv4-mapped IPv6 as its IPv4 address. Anything else (such
 * as "unknown") is returned unchanged.
 */
export function clientNetworkKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const h = expandIpv6(ip);
  if (!h) return ip;
  const [h0, h1, h2, h3, h4, h5, hi = 0, lo = 0] = h;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${h
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}
