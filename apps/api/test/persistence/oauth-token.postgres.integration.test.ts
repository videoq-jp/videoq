import {describe} from 'vitest';
import {hashPassword} from 'better-auth/crypto';
import {drizzle} from 'drizzle-orm/node-postgres';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import * as schema from '../../src/db/schema';
import * as authSchema from '../../src/db/schema/better-auth';
import {createAuth} from '../../src/persistence/postgres/auth';
import {isolatedPostgres} from './isolated-postgres';
import {oauthTokenContract,oauthTokenUserId,oauthTokenPassword,oauthTokenSettings} from './contracts/oauth-token.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL OAuth token persistence',()=>oauthTokenContract('same token contract',async()=>{
 const f=await isolatedPostgres(url!);try{
  const statements=await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users:schema.users,...authSchema}));await f.pool.query(statements.map(sql=>sql.replaceAll('"public".','')).join('\n'),[]);
  const db=drizzle(f.pool,{schema});
  await db.insert(schema.users).values({id:oauthTokenUserId,username:'oauthcontract',email:'oauth-contract@example.test',emailVerified:true,isOverQuota:false,usedAiAnswers:0,usedProcessingSeconds:0,usedStorageBytes:0,passwordResetRequired:false});
  await db.insert(schema.account).values({id:'oauth-account',accountId:oauthTokenUserId,providerId:'credential',userId:oauthTokenUserId,password:await hashPassword(oauthTokenPassword)});
  return {auth:createAuth({...oauthTokenSettings,DEPLOYMENT_EDITION:'onprem'} as Bindings,db),
   ban:async value=>{await f.pool.query('UPDATE users SET banned=$1 WHERE id=$2',[value,oauthTokenUserId]);},
   counts:async()=>(await f.pool.query<{refresh:number;access:number}>('SELECT (SELECT count(*)::int FROM oauth_refresh_token) AS refresh,(SELECT count(*)::int FROM oauth_access_token) AS access')).rows[0],
   refreshTokens:async()=>(await f.pool.query<{token:string;revoked:unknown}>('SELECT token,revoked FROM oauth_refresh_token')).rows.map(r=>({token:r.token,revoked:r.revoked!==null})),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
}));
