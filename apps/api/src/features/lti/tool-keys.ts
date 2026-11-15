import {calculateJwkThumbprint,importJWK,SignJWT,type JWK} from 'jose';
import type {Bindings} from '../../types/bindings';
import {hasSecretEncryptionKey} from '../../lib/secret-encryption';
import {createToolKeyRepository} from '../../persistence/factory';
import {parseKeys,parseStoredToolKeyRing,generateEncryptedToolKeyRing,type KeyRing,type ToolKeyEnvironment} from '../../shared/lti-tool-keyring';
export type {ToolKeyEnvironment} from '../../shared/lti-tool-keyring';
async function keys(env:ToolKeyEnvironment):Promise<KeyRing|null>{
  if(env.LTI_TOOL_KEYS?.trim())return parseKeys(env.LTI_TOOL_KEYS);
  if(!hasSecretEncryptionKey(env))return null;
  try{
    const encrypted=await (await createToolKeyRepository(env as Bindings)).readEncrypted();
    return encrypted?await parseStoredToolKeyRing(env,encrypted):null;
  }catch{throw new Error('LTI signing keys could not be loaded');}
}
/** Call only after authorizing the operation that needs managed signing keys. */
export async function ensureManagedToolKeys(env:ToolKeyEnvironment):Promise<void>{
  if(env.LTI_TOOL_KEYS?.trim()){parseKeys(env.LTI_TOOL_KEYS);return;}
  if(!hasSecretEncryptionKey(env))throw new Error('LTI signing keys are unavailable');
  try{
    const repository=await createToolKeyRepository(env as Bindings);
    const existing=await repository.readEncrypted();
    if(existing){await parseStoredToolKeyRing(env,existing);return;}
    const stored=await repository.initializeEncrypted(await generateEncryptedToolKeyRing(env));
    await parseStoredToolKeyRing(env,stored);
  }catch{throw new Error('LTI signing-key initialization failed');}
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
