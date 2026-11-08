import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt, clearAccessKeyCache } from "../src/access.ts";

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-123";
const NOW = 1_800_000_000;

const b64url = (data: Uint8Array | string) =>
  Buffer.from(data).toString("base64url");

const { publicKey, privateKey } = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };

const fakeFetch = (async (url: string) => {
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
}) as typeof fetch;

async function sign(payload: object, header: object = { alg: "RS256", kid: "k1" }) {
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(head),
  );
  return `${head}.${b64url(new Uint8Array(sig))}`;
}

const good = {
  aud: [AUD],
  iss: `https://${TEAM}`,
  exp: NOW + 600,
  email: "me@example.com",
};
const config = { teamDomain: TEAM, aud: AUD };
const verify = (token: string | null, cfg = config) =>
  verifyAccessJwt(token, cfg, fakeFetch, NOW);

beforeEach(() => clearAccessKeyCache());

test("accepts a valid token", async () => {
  assert.deepEqual(await verify(await sign(good)), { email: "me@example.com" });
});

test("accepts a team domain written as a URL", async () => {
  const token = await sign(good);
  assert.ok(await verify(token, { teamDomain: `https://${TEAM}/`, aud: AUD }));
});

test("rejects missing or malformed tokens", async () => {
  assert.equal(await verify(null), null);
  assert.equal(await verify("not.a.jwt"), null);
  assert.equal(await verify("abc"), null);
});

test("rejects wrong audience, issuer, or expired tokens", async () => {
  assert.equal(await verify(await sign({ ...good, aud: ["other"] })), null);
  assert.equal(await verify(await sign({ ...good, iss: "https://evil.cloudflareaccess.com" })), null);
  assert.equal(await verify(await sign({ ...good, exp: NOW - 3600 })), null);
});

test("rejects a tampered payload", async () => {
  const [h, , s] = (await sign(good)).split(".");
  const forged = b64url(JSON.stringify({ ...good, email: "attacker@example.com" }));
  assert.equal(await verify(`${h}.${forged}.${s}`), null);
});

test("rejects unknown key ids and non-RS256 algorithms", async () => {
  assert.equal(await verify(await sign(good, { alg: "RS256", kid: "nope" })), null);
  assert.equal(await verify(await sign(good, { alg: "none", kid: "k1" })), null);
});
