import { describe, expect, it } from "vitest";
import { createDecipheriv } from "node:crypto";
import { decryptServerSecret, encryptServerSecret, encryptUserSecret, hasSecretEncryptionKey } from "../src/lib/secret-encryption";
import type { Bindings } from "../src/types/bindings";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const env = { USER_SECRET_ENCRYPTION_KEY: key } as Bindings;

// Verify the wire format with Node's crypto rather than a second API implementation.
function decryptEnvelope(envelope: string): string {
  const [, nonce, payload] = envelope.split(".");
  const ciphertext = Buffer.from(payload, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 7), Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8");
}

describe("user secret encryption", () => {
  it("round-trips a versioned AES-GCM envelope", async () => {
    const encrypted = await encryptUserSecret(env, "search-api-key");
    expect(encrypted).toMatch(/^v1\.[^.]+\.[^.]+$/);
    expect(decryptEnvelope(encrypted)).toBe("search-api-key");
  });

  it("rejects tampered values", async () => {
    const encrypted = await encryptUserSecret(env, "search-api-key");
    const [version, nonce, payload] = encrypted.split(".");
    const tampered = Buffer.from(payload, "base64url");
    tampered[0] ^= 1;
    expect(() => decryptEnvelope(`${version}.${nonce}.${tampered.toString("base64url")}`)).toThrow();
  });
});

describe("server secret encryption", () => {
  it("authenticates the purpose using a separately versioned envelope", async () => {
    const value = await encryptServerSecret(env, "private signing material", "lti-keys");
    const [, nonce, payload] = value.split(".");
    const bytes = Buffer.from(payload, "base64url");
    const decoder = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 7), Buffer.from(nonce, "base64url"));
    decoder.setAAD(Buffer.from("lti-keys")); decoder.setAuthTag(bytes.subarray(-16));
    expect(Buffer.concat([decoder.update(bytes.subarray(0, -16)), decoder.final()]).toString()).toBe("private signing material");
    expect(await decryptServerSecret(env, value, "lti-keys")).toBe("private signing material");
    await expect(decryptServerSecret(env, value, "another-purpose")).rejects.toThrow("could not be decrypted");
    await expect(decryptServerSecret(env, value, "")).rejects.toThrow("could not be decrypted");
    await expect(decryptServerSecret({ USER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64url") } as Bindings, value, "lti-keys")).rejects.toThrow("could not be decrypted");
  });
  it("does not accept a user-secret envelope as a server signing key", async () => {
    const userValue = await encryptUserSecret(env, "private signing material");
    await expect(decryptServerSecret(env, userValue, "lti-keys")).rejects.toThrow("could not be decrypted");
  });
  it("uses a fresh nonce and detects changed ciphertext", async () => {
    const value = await encryptServerSecret(env, "private signing material", "lti-keys");
    expect(await encryptServerSecret(env, "private signing material", "lti-keys")).not.toBe(value);
    const [version, nonce, payload] = value.split("."); const bytes = Buffer.from(payload, "base64url"); bytes[0] ^= 1;
    await expect(decryptServerSecret(env, `${version}.${nonce}.${bytes.toString("base64url")}`, "lti-keys")).rejects.toThrow("could not be decrypted");
  });
  it("recognizes existing padded and unpadded master keys without accepting partial configuration", () => {
    expect(hasSecretEncryptionKey(env)).toBe(true);
    expect(hasSecretEncryptionKey({ USER_SECRET_ENCRYPTION_KEY: key + "=" })).toBe(true);
    for (const invalid of [undefined, "", "configured", "a".repeat(64), "?"])
      expect(hasSecretEncryptionKey({ USER_SECRET_ENCRYPTION_KEY: invalid })).toBe(false);
  });
});
