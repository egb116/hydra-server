/**
 * Verifies the JWT that Cloudflare Access adds to requests it lets through
 * (the Cf-Access-Jwt-Assertion header). Checking it here means the page stays
 * locked even if the Access application is removed or misconfigured.
 *
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

export type AccessConfig = {
  /** e.g. "yourteam.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
};

export type AccessIdentity = { email: string | null };

type Jwk = JsonWebKey & { kid?: string };

const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function getKeys(
  certsUrl: string,
  fetchFn: typeof fetch,
  forceRefresh: boolean,
): Promise<Jwk[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    jwksCache?.url === certsUrl &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }
  const res = await fetchFn(certsUrl);
  if (!res.ok) throw new Error(`Access certs request failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { url: certsUrl, keys: keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
}

export function normalizeTeamDomain(teamDomain: string): string {
  return teamDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

/** Returns the identity if the token is valid, otherwise null. */
export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  fetchFn: typeof fetch = fetch,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AccessIdentity | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ];

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string | string[];
    iss?: string;
    exp?: number;
    nbf?: number;
    email?: string;
  };
  try {
    header = decodeJson(headerB64);
    payload = decodeJson(payloadB64);
  } catch (_e) {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const team = normalizeTeamDomain(config.teamDomain);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.aud)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds - 60) {
    return null;
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + 60) {
    return null;
  }

  const certsUrl = `https://${team}/cdn-cgi/access/certs`;
  let jwk = (await getKeys(certsUrl, fetchFn, false)).find(
    (k) => k.kid === header.kid,
  );
  if (!jwk) {
    // Access rotates keys; refetch once before giving up.
    jwk = (await getKeys(certsUrl, fetchFn, true)).find(
      (k) => k.kid === header.kid,
    );
  }
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  return valid ? { email: payload.email ?? null } : null;
}

/** For tests. */
export function clearAccessKeyCache() {
  jwksCache = null;
}
