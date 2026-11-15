import {eq,sql} from 'drizzle-orm';
import {withDb,type Db} from '../../db/pool';
import {ltiToolKeys} from '../../db/schema';
import {hasSecretEncryptionKey} from '../../lib/secret-encryption';
import {identity,parseKeys,parseStoredToolKeyRing,generateEncryptedToolKeyRing,type ToolKeyEnvironment} from '../../shared/lti-tool-keyring';
import type {Bindings} from '../../types/bindings';
import type {ToolKeyRepository} from '../contracts/tool-key-repository';
type KeyStore=Pick<Db,'select'|'insert'|'execute'>;
async function read(store:Pick<Db,'select'>){return (await store.select({encrypted:ltiToolKeys.encryptedKeyRing}).from(ltiToolKeys).where(eq(ltiToolKeys.id,identity)))[0]?.encrypted??null;}
/** Reuses the authenticated owner's transaction and avoids a second pooled connection. */
export async function ensureToolKeys(env:ToolKeyEnvironment,transaction:KeyStore):Promise<void>{
  if(env.LTI_TOOL_KEYS?.trim()){parseKeys(env.LTI_TOOL_KEYS);return;}
  if(!hasSecretEncryptionKey(env))throw new Error('LTI signing keys are unavailable');
  try{
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(998,1)`);
    const stored=await read(transaction);if(stored){await parseStoredToolKeyRing(env,stored);return;}
    await transaction.insert(ltiToolKeys).values({id:identity,encryptedKeyRing:await generateEncryptedToolKeyRing(env)});
  }catch{throw new Error('LTI signing-key initialization failed');}
}
export function createPostgresToolKeyRepository(env:Bindings):ToolKeyRepository {
  return {readEncrypted:()=>withDb(env,read),initializeEncrypted:candidate=>withDb(env,db=>db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(998,1)`);
    await tx.insert(ltiToolKeys).values({id:identity,encryptedKeyRing:candidate}).onConflictDoNothing({target:ltiToolKeys.id});
    const stored=await read(tx);if(!stored)throw new Error('Missing managed signing keys');return stored;
  }))};
}
