import {exportJWK,generateKeyPair} from 'jose';
import {z} from 'zod';
import type {Bindings} from '../types/bindings';
import {decryptServerSecret,encryptServerSecret} from '../lib/secret-encryption';
const publicKey = z.object({ kty: z.literal("RSA"), n: z.string().min(1), e: z.string().min(1) }).strict();
const privateKey = publicKey.extend({ d: z.string().min(1), p: z.string().min(1), q: z.string().min(1),
  dp: z.string().min(1), dq: z.string().min(1), qi: z.string().min(1) }).strict();
const keyRing = z.object({ current: privateKey, previous: z.array(publicKey).max(3).default([]) }).strict();
export const purpose = "videoq:lti-tool-keys:v1";
export const identity = "default";
export type KeyRing = z.infer<typeof keyRing>;
export type ToolKeyEnvironment = Pick<Bindings, "LTI_TOOL_KEYS"> & Partial<Pick<Bindings,
  "USER_SECRET_ENCRYPTION_KEY" | "DATABASE_URL" | "DATABASE_POOL" | "HYPERDRIVE" | "DB" | "DEPLOYMENT_EDITION" | "RUNTIME" | "PERSISTENCE_BACKEND" | "MIGRATION_ALLOW_CLOUD_POSTGRES">>;

export function parseKeys(value: string): KeyRing {
  try {
    const ring = keyRing.parse(JSON.parse(value));
    for (const key of [ring.current, ...ring.previous]) {
      // A 2048-bit RSA modulus is at least 256 octets (base64url length 342).
      if (key.n.length < 342) throw new Error();
    }
    return ring;
  } catch { throw new Error("Invalid LTI tool signing-key configuration"); }
}


export async function parseStoredToolKeyRing(env:ToolKeyEnvironment,encrypted:string):Promise<KeyRing>{return parseKeys(await decryptServerSecret(env as Bindings,encrypted,purpose));}
export async function generateEncryptedToolKeyRing(env:ToolKeyEnvironment):Promise<string>{
  const generated=await generateKeyPair('RS256',{extractable:true,modulusLength:2048});
  const ring=parseKeys(JSON.stringify({current:await exportJWK(generated.privateKey),previous:[]}));
  return encryptServerSecret(env as Bindings,JSON.stringify(ring),purpose);
}
