import { describe, expect, test } from "bun:test";
import {
  createKeyring,
  createSecretBox,
  CryptoError,
  isLegacy,
  keyIdOf,
  redditSecretAad,
} from "../src/lib/crypto";
import { TEST_KEY, TEST_KEY_2, v1Encrypt } from "./helpers";

const aad = redditSecretAad(42, "alice");

describe("crypto", () => {
  test("v2 roundtrip and envelope format", () => {
    const box = createSecretBox(createKeyring(TEST_KEY));
    const blob = box.encryptSecret("token_v2=abc; reddit_session=xyz", aad);
    expect(blob).toMatch(/^v2:[0-9a-f]{8}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(blob.split(":")[1]).toBe(keyIdOf(Buffer.from(TEST_KEY, "hex")));
    expect(isLegacy(blob)).toBe(false);
    expect(box.decryptSecret(blob, aad)).toBe("token_v2=abc; reddit_session=xyz");
    // Unicode survives, and each encryption uses a fresh IV.
    const unicode = "sésame 🔑";
    expect(box.decryptSecret(box.encryptSecret(unicode, aad), aad)).toBe(unicode);
    expect(box.encryptSecret("same", aad)).not.toBe(box.encryptSecret("same", aad));
  });

  test("AAD mismatch fails", () => {
    const box = createSecretBox(createKeyring(TEST_KEY));
    const blob = box.encryptSecret("secret", aad);
    expect(() => box.decryptSecret(blob, redditSecretAad(43, "alice"))).toThrow(CryptoError);
    expect(() => box.decryptSecret(blob, redditSecretAad(42, "bob"))).toThrow(CryptoError);
  });

  test("tampered ciphertext fails", () => {
    const box = createSecretBox(createKeyring(TEST_KEY));
    const parts = box.encryptSecret("secret", aad).split(":");
    const ct = Buffer.from(parts[4]!, "base64url");
    ct[0] = ct[0]! ^ 1;
    parts[4] = ct.toString("base64url");
    expect(() => box.decryptSecret(parts.join(":"), aad)).toThrow(CryptoError);
    expect(() => box.decryptSecret("v2:abc", aad)).toThrow("malformed");
  });

  test("decrypts a blob produced by the v1 algorithm, ignoring AAD", () => {
    const session = "eyJhbGciOi.v1-session-cookie.value";
    const v1 = v1Encrypt(session, TEST_KEY);
    expect(v1).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
    expect(isLegacy(v1)).toBe(true);
    const box = createSecretBox(createKeyring(TEST_KEY));
    expect(box.decryptSecret(v1, aad)).toBe(session);
    expect(box.decryptSecret(v1, "any other aad")).toBe(session);
    expect(() => box.decryptSecret("not-a-blob", aad)).toThrow(CryptoError);
  });

  test("v1 blobs are tried against every key", () => {
    const v1 = v1Encrypt("old-session", TEST_KEY_2);
    expect(() => createSecretBox(createKeyring(TEST_KEY)).decryptSecret(v1, aad)).toThrow(
      CryptoError,
    );
    const box = createSecretBox(createKeyring(TEST_KEY, [TEST_KEY_2]));
    expect(box.decryptSecret(v1, aad)).toBe("old-session");
  });

  test("needsReencrypt flags v1 blobs and v2 blobs under a previous key", () => {
    const box = createSecretBox(createKeyring(TEST_KEY, [TEST_KEY_2]));
    const oldBlob = createSecretBox(createKeyring(TEST_KEY_2)).encryptSecret("s", aad);
    expect(box.needsReencrypt(v1Encrypt("s", TEST_KEY))).toBe(true);
    expect(box.needsReencrypt(oldBlob)).toBe(true);
    expect(box.needsReencrypt(box.encryptSecret("s", aad))).toBe(false);
  });

  test("key rotation: old v2 blobs decrypt with previous keys, new ones use the current key", () => {
    const oldBox = createSecretBox(createKeyring(TEST_KEY_2));
    const oldBlob = oldBox.encryptSecret("rotated", aad);

    const rotated = createSecretBox(createKeyring(TEST_KEY, [TEST_KEY_2]));
    expect(rotated.decryptSecret(oldBlob, aad)).toBe("rotated");
    const newBlob = rotated.encryptSecret("rotated", aad);
    expect(newBlob.split(":")[1]).toBe(rotated.keyring.current.id);
    expect(newBlob.split(":")[1]).not.toBe(oldBlob.split(":")[1]);

    // Once the old key is dropped from the keyring, its blobs no longer decrypt.
    expect(() => createSecretBox(createKeyring(TEST_KEY)).decryptSecret(oldBlob, aad)).toThrow(
      "no key in the keyring",
    );
  });
});
