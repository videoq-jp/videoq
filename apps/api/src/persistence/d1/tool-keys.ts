import {eq} from 'drizzle-orm';
import {createD1Connection} from '../../db/d1/connection';
import {ltiToolKeys} from '../../db/schema/sqlite';
import {identity} from '../../shared/lti-tool-keyring';
import type {ToolKeyRepository} from '../contracts/tool-key-repository';
export function createD1ToolKeyRepository(database:D1Database):ToolKeyRepository {
  const db=createD1Connection(database);
  const select=()=>db.select({encrypted:ltiToolKeys.encryptedKeyRing}).from(ltiToolKeys).where(eq(ltiToolKeys.id,identity));
  return {async readEncrypted(){return (await select())[0]?.encrypted??null;},async initializeEncrypted(candidate){
    const [,rows]=await db.batch([db.insert(ltiToolKeys).values({id:identity,encryptedKeyRing:candidate}).onConflictDoNothing({target:ltiToolKeys.id}),select()]);
    if(!rows[0])throw new Error('Missing managed signing keys');return rows[0].encrypted;
  }};
}
