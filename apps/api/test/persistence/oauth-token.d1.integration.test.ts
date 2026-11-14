import {hashPassword} from 'better-auth/crypto';
import {createD1Fixture} from './d1-fixture';
import {createD1Connection} from '../../src/db/d1/connection';
import {users,account} from '../../src/db/schema/sqlite';
import {createD1Auth} from '../../src/persistence/d1/auth';
import {oauthTokenContract,oauthTokenUserId,oauthTokenPassword,oauthTokenSettings} from './contracts/oauth-token.contract';
import type {Bindings} from '../../src/types/bindings';
oauthTokenContract('D1 OAuth token persistence',async()=>{
 const f=await createD1Fixture();try{
  const db=createD1Connection(f.database);
  await db.insert(users).values({id:oauthTokenUserId,username:'oauthcontract',email:'oauth-contract@example.test',emailVerified:true,isOverQuota:false,usedAiAnswers:0,usedProcessingSeconds:0,usedStorageBytes:0,passwordResetRequired:false});
  await db.insert(account).values({id:'oauth-account',accountId:oauthTokenUserId,providerId:'credential',userId:oauthTokenUserId,password:await hashPassword(oauthTokenPassword)});
  return {auth:createD1Auth({...oauthTokenSettings,DEPLOYMENT_EDITION:'cloud',DB:f.database} as Bindings,f.database),
   ban:async value=>{await f.database.prepare('UPDATE users SET banned=? WHERE id=?').bind(value?1:0,oauthTokenUserId).run();},
   counts:async()=>({refresh:await f.database.prepare('SELECT count(*) AS n FROM oauth_refresh_token').first<number>('n')??0,access:await f.database.prepare('SELECT count(*) AS n FROM oauth_access_token').first<number>('n')??0}),
   refreshTokens:async()=>(await f.database.prepare('SELECT token,revoked FROM oauth_refresh_token').all<{token:string;revoked:unknown}>()).results.map(r=>({token:r.token,revoked:r.revoked!==null})),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
