import type { Bindings } from "../types/bindings";

function decodeBase64Url(value: string): Uint8Array {
  let b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const binary = atob(b64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hasSecretEncryptionKey(env: Partial<Pick<Bindings, "USER_SECRET_ENCRYPTION_KEY">>): boolean {
  try {
    return typeof env.USER_SECRET_ENCRYPTION_KEY === "string"
      && /^[A-Za-z0-9_-]+={0,2}$/.test(env.USER_SECRET_ENCRYPTION_KEY.trim())
      && decodeBase64Url(env.USER_SECRET_ENCRYPTION_KEY.trim()).length === 32;
  } catch { return false; }
}

async function encryptionKey(env: Bindings, usages: ("encrypt" | "decrypt")[] = ["encrypt"]): Promise<CryptoKey> {
  const bytes = decodeBase64Url(env.USER_SECRET_ENCRYPTION_KEY.trim());
  if (bytes.length !== 32) {
    throw new Error("USER_SECRET_ENCRYPTION_KEY must contain 32 base64url bytes");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
}

/** Server-owned values use authenticated purpose binding; v1 user envelopes stay unchanged. */
export async function encryptServerSecret(env: Bindings, plaintext: string, purpose: string): Promise<string> {
  if (!purpose) throw new Error("A server-secret purpose is required");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(purpose) },
    await encryptionKey(env), new TextEncoder().encode(plaintext),
  ));
  return `v2.${encodeBase64Url(nonce)}.${encodeBase64Url(ciphertext)}`;
}

export async function decryptServerSecret(env: Bindings, envelope: string, purpose: string): Promise<string> {
  try {
    if (!purpose) throw new Error();
    const parts = envelope.split(".");
    if (parts.length !== 3 || parts[0] !== "v2" || !parts.slice(1).every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error();
    const nonce = decodeBase64Url(parts[1]);
    if (nonce.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(purpose) },
      await encryptionKey(env, ["decrypt"]), decodeBase64Url(parts[2]),
    );
    return new TextDecoder().decode(plaintext);
  } catch { throw new Error("Server secret could not be decrypted"); }
}

/** `v1.<nonce>.<ciphertext+tag>` AES-256-GCM envelope. */
export async function encryptUserSecret(
  env: Bindings,
  plaintext: string,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await encryptionKey(env),
      new TextEncoder().encode(plaintext),
    ),
  );
  return `v1.${encodeBase64Url(nonce)}.${encodeBase64Url(ciphertext)}`;
}
