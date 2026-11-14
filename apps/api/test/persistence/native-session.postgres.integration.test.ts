import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,ltiCredentials} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {nativeSessionContract} from './contracts/native-session.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL native learning',()=>{
 nativeSessionContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!);try{
   for(const statement of await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,ltiCredentials})))await f.pool.query(statement.replaceAll('"public".',''));
   await f.pool.query("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',false,0,0,0)");
   return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings,
    execute:async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);},
    rows:async()=>(await f.pool.query<{id:string;kind:string;payload:Record<string,unknown>;expiresAt:Date}>('SELECT id,kind,payload,expires_at AS "expiresAt" FROM lti_credentials ORDER BY id')).rows.map(r=>({...r,expiresAt:r.expiresAt.toISOString()})),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
