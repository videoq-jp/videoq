import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Bindings } from "../../types/bindings";
import { withDb, type Db } from "../../db/pool";
import { ltiToolKeys } from "../../db/schema";
import { decryptServerSecret, encryptServerSecret, hasSecretEncryptionKey } from "../../lib/secret-encryption";

const publicKey = z.object({ kty: z.literal("RSA"), n: z.string().min(1), e: z.string().min(1) }).strict();
const privateKey = publicKey.extend({ d: z.string().min(1), p: z.string().min(1), q: z.string().min(1),
  dp: z.string().min(1), dq: z.string().min(1), qi: z.string().min(1) }).strict();
const keyRing = z.object({ current: privateKey, previous: z.array(publicKey).max(3).default([]) }).strict();
const purpose = "videoq:lti-tool-keys:v1";
const identity = "default";
type KeyRing = z.infer<typeof keyRing>;
type KeyStore = Pick<Db, "select" | "insert" | "execute">;
export type ToolKeyEnvironment = Pick<Bindings, "LTI_TOOL_KEYS"> & Partial<Pick<Bindings,
  "USER_SECRET_ENCRYPTION_KEY" | "DATABASE_URL" | "DATABASE_POOL" | "HYPERDRIVE">>;

function parseKeys(value: string): KeyRing {
  try {
    const ring = keyRing.parse(JSON.parse(value));
    for (const key of [ring.current, ...ring.previous]) {
      // A 2048-bit RSA modulus is at least 256 octets (base64url length 342).
      if (key.n.length < 342) throw new Error();
    }
    return ring;
  } catch { throw new Error("Invalid LTI tool signing-key configuration"); }
}

async function managedKeys(env: ToolKeyEnvironment, store: KeyStore): Promise<KeyRing | null> {
  const [stored] = await store.select({ encrypted: ltiToolKeys.encryptedKeyRing }).from(ltiToolKeys).where(eq(ltiToolKeys.id, identity));
  return stored ? parseKeys(await decryptServerSecret(env as Bindings, stored.encrypted, purpose)) : null;
}

async function keys(env: ToolKeyEnvironment): Promise<KeyRing | null> {
  if (env.LTI_TOOL_KEYS?.trim()) return parseKeys(env.LTI_TOOL_KEYS);
  if (!hasSecretEncryptionKey(env)) return null;
  try { return await withDb(env as Bindings, db => managedKeys(env, db)); }
  catch { throw new Error("LTI signing keys could not be loaded"); }
}

/** Called only after authenticating/locking the owner, using that same transaction. */
export async function ensureToolKeys(env: ToolKeyEnvironment, transaction: KeyStore): Promise<void> {
  if (env.LTI_TOOL_KEYS?.trim()) { parseKeys(env.LTI_TOOL_KEYS); return; }
  if (!hasSecretEncryptionKey(env)) throw new Error("LTI signing keys are unavailable");
  try {
    // One initialization across processes/replicas. A transaction-scoped lock
    // cannot outlive rollback, and reusing the owner's connection avoids pool deadlocks.
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(998, 1)`);
    if (await managedKeys(env, transaction)) return;
    const generated = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
    const ring = parseKeys(JSON.stringify({ current: await exportJWK(generated.privateKey), previous: [] }));
    const encrypted = await encryptServerSecret(env as Bindings, JSON.stringify(ring), purpose);
    await transaction.insert(ltiToolKeys).values({ id: identity, encryptedKeyRing: encrypted });
  } catch { throw new Error("LTI signing-key initialization failed"); }
}
async function publicJwk(key: JWK) {
  // Select public components explicitly; never rely on a serializer stripping secrets.
  const value = { kty: "RSA", n: key.n!, e: key.e! };
  return { ...value, kid: await calculateJwkThumbprint(value), alg: "RS256", use: "sig" };
}
export async function toolJwks(env: ToolKeyEnvironment) {
  const ring = await keys(env);
  if (!ring) return { keys: [] };
  const published = await Promise.all([ring.current, ...ring.previous].map(publicJwk));
  return { keys: published.filter((item, index) => published.findIndex(key => key.kid === item.kid) === index) };
}
export async function toolClientAssertion(env: ToolKeyEnvironment,
  clientId: string, deploymentId: string, tokenEndpoint: string) {
  const ring = await keys(env);
  if (!ring) throw new Error("LTI signing keys are unavailable");
  const key = await importJWK(ring.current, "RS256");
  const publicPart = await publicJwk(ring.current);
  return new SignJWT({ "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deploymentId })
    .setProtectedHeader({ alg: "RS256", kid: publicPart.kid, typ: "JWT" })
    .setIssuer(clientId).setSubject(clientId).setAudience(tokenEndpoint)
    .setIssuedAt().setExpirationTime("60s").setJti(crypto.randomUUID()).sign(key);
}
