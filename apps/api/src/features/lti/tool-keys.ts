import { calculateJwkThumbprint, importJWK, SignJWT, type JWK } from "jose";
import { z } from "zod";
import type { Bindings } from "../../types/bindings";

const publicKey = z.object({ kty: z.literal("RSA"), n: z.string().min(1), e: z.string().min(1) }).strict();
const privateKey = publicKey.extend({ d: z.string().min(1), p: z.string().min(1), q: z.string().min(1),
  dp: z.string().min(1), dq: z.string().min(1), qi: z.string().min(1) }).strict();
const keyRing = z.object({ current: privateKey, previous: z.array(publicKey).max(3).default([]) }).strict();

/** Operator-managed secret. Retired public keys allow overlap during rotation. */
function keys(env: Pick<Bindings, "LTI_TOOL_KEYS">) {
  try {
    const ring = keyRing.parse(JSON.parse(env.LTI_TOOL_KEYS ?? ""));
    for (const key of [ring.current, ...ring.previous]) {
      // A 2048-bit RSA modulus is at least 256 octets (base64url length 342).
      if (key.n.length < 342) throw new Error();
    }
    return ring;
  } catch { throw new Error("Invalid LTI tool signing-key configuration"); }
}
async function publicJwk(key: JWK) {
  // Select public components explicitly; never rely on a serializer stripping secrets.
  const value = { kty: "RSA", n: key.n!, e: key.e! };
  return { ...value, kid: await calculateJwkThumbprint(value), alg: "RS256", use: "sig" };
}
export async function toolJwks(env: Pick<Bindings, "LTI_TOOL_KEYS">) {
  const ring = keys(env);
  const published = await Promise.all([ring.current, ...ring.previous].map(publicJwk));
  return { keys: published.filter((item, index) => published.findIndex(key => key.kid === item.kid) === index) };
}
export async function toolClientAssertion(env: Pick<Bindings, "LTI_TOOL_KEYS">,
  clientId: string, deploymentId: string, tokenEndpoint: string) {
  const ring = keys(env);
  const key = await importJWK(ring.current, "RS256");
  const publicPart = await publicJwk(ring.current);
  return new SignJWT({ "https://purl.imsglobal.org/spec/lti/claim/deployment_id": deploymentId })
    .setProtectedHeader({ alg: "RS256", kid: publicPart.kid, typ: "JWT" })
    .setIssuer(clientId).setSubject(clientId).setAudience(tokenEndpoint)
    .setIssuedAt().setExpirationTime("60s").setJti(crypto.randomUUID()).sign(key);
}
