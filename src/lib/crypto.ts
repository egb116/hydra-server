import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Secret envelopes.
 *
 * v2: `v2:<keyId>:<iv>:<tag>:<ct>`, AES-256-GCM, base64url parts, 12-byte IV,
 * with caller-chosen additional authenticated data (AAD), so a ciphertext
 * can't be moved to another row. The key id says which key of the keyring
 * encrypted it.
 *
 * v1 (legacy, decrypt only): `<ivHex>:<ctHex>`, AES-256-CBC with a 16-byte IV
 * and no AAD, exactly as v1's utils/crypto.ts produced it. v1 blobs carry no
 * key id, so every key in the keyring is tried.
 */

const V2_PREFIX = "v2:";
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CBC_IV_BYTES = 16;

export interface Key {
  /** First 8 hex chars of sha256(key). */
  readonly id: string;
  readonly bytes: Buffer;
}

export interface Keyring {
  readonly current: Key;
  /** Current first, then previous keys in the order given. */
  readonly all: readonly Key[];
}

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoError";
  }
}

export function keyIdOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

function keyFromHex(hex: string): Key {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new CryptoError("encryption keys must be exactly 64 hex characters");
  }
  const bytes = Buffer.from(hex, "hex");
  return { id: keyIdOf(bytes), bytes };
}

/** Builds a keyring from the current key and the previous (decrypt-only) keys. */
export function createKeyring(currentHex: string, previousHex: readonly string[] = []): Keyring {
  const current = keyFromHex(currentHex);
  const all: Key[] = [current];
  for (const hex of previousHex) {
    const key = keyFromHex(hex);
    if (!all.some((k) => k.id === key.id)) all.push(key);
  }
  return { current, all };
}

/** True for anything that is not a v2 envelope (v1 blobs are re-encrypted lazily). */
export function isLegacy(blob: string): boolean {
  return !blob.startsWith(V2_PREFIX);
}

/**
 * True when the blob is not a v2 envelope under the current key: a v1 blob, or a
 * v2 envelope under a key from ENCRYPTION_KEYS_PREVIOUS. Callers re-encrypt such
 * blobs when they have the plaintext, so a key rotation finishes on its own.
 */
export function needsReencrypt(keyring: Keyring, blob: string): boolean {
  return isLegacy(blob) || blob.split(":", 2)[1] !== keyring.current.id;
}

export function encryptWith(keyring: Keyring, plaintext: string, aad: string): string {
  const key = keyring.current;
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v2",
    key.id,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(":");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function decryptV2(keyring: Keyring, blob: string, aad: string): string {
  const [version, keyId, ivPart, tagPart, ctPart, ...extra] = blob.split(":");
  if (
    version !== "v2" ||
    keyId === undefined ||
    ivPart === undefined ||
    tagPart === undefined ||
    ctPart === undefined ||
    extra.length > 0
  ) {
    throw new CryptoError("malformed v2 envelope");
  }
  const key = keyring.all.find((k) => k.id === keyId);
  if (!key) throw new CryptoError(`no key in the keyring with id ${keyId}`);
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new CryptoError("malformed v2 envelope");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, iv, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    throw new CryptoError("v2 decryption failed (wrong key or AAD, or tampered data)", {
      cause: err,
    });
  }
}

function decryptV1(keyring: Keyring, blob: string): string {
  // v1: iv.toString("hex") + ":" + encrypted.toString("hex")
  const sep = blob.indexOf(":");
  if (sep < 0) throw new CryptoError("malformed v1 blob");
  const ivHex = blob.slice(0, sep);
  const ctHex = blob.slice(sep + 1);
  if (!/^[0-9a-fA-F]{32}$/.test(ivHex) || !/^(?:[0-9a-fA-F]{2})+$/.test(ctHex)) {
    throw new CryptoError("malformed v1 blob");
  }
  const iv = Buffer.from(ivHex, "hex");
  if (iv.length !== CBC_IV_BYTES) throw new CryptoError("malformed v1 blob");
  const ct = Buffer.from(ctHex, "hex");
  for (const key of keyring.all) {
    try {
      const decipher = createDecipheriv("aes-256-cbc", key.bytes, iv);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      // CBC has no authentication: a wrong key passes the padding check about
      // 1 time in 256. v1 only ever encrypted JS strings as UTF-8, so invalid
      // UTF-8 means a wrong key.
      return strictUtf8.decode(pt);
    } catch {
      // Try the next key.
    }
  }
  throw new CryptoError("v1 decryption failed with every key in the keyring");
}

export function decryptWith(keyring: Keyring, blob: string, aad: string): string {
  return isLegacy(blob) ? decryptV1(keyring, blob) : decryptV2(keyring, blob, aad);
}

/** Encrypts and decrypts secrets with a fixed keyring. */
export interface SecretBox {
  /** Always produces a v2 envelope with the current key. */
  encryptSecret(plaintext: string, aad: string): string;
  /** Decrypts a v2 envelope (AAD must match) or a legacy v1 blob (AAD ignored). */
  decryptSecret(blob: string, aad: string): string;
  isLegacy(blob: string): boolean;
  /** v1, or v2 under a previous key: re-encrypt it with the plaintext in hand. */
  needsReencrypt(blob: string): boolean;
  readonly keyring: Keyring;
}

export function createSecretBox(keyring: Keyring): SecretBox {
  return {
    keyring,
    encryptSecret: (plaintext, aad) => encryptWith(keyring, plaintext, aad),
    decryptSecret: (blob, aad) => decryptWith(keyring, blob, aad),
    isLegacy,
    needsReencrypt: (blob) => needsReencrypt(keyring, blob),
  };
}

/** A SecretBox for the configured ENCRYPTION_KEY and ENCRYPTION_KEYS_PREVIOUS. */
export function secretBoxFromConfig(config: {
  encryptionKey: string;
  encryptionKeysPrevious: readonly string[];
}): SecretBox {
  return createSecretBox(createKeyring(config.encryptionKey, config.encryptionKeysPrevious));
}

/** The AAD for a reddit account's session and token. */
export function redditSecretAad(customerRowId: number, username: string): string {
  return `reddit:${customerRowId}:${username}`;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Constant-time string equality, whatever the lengths: compares SHA-256 digests. */
export function digestEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}
