import {createPrivacyAuthorizationRepository} from '../../src/persistence/factory';
import {executePrivacyRequest} from '../../src/features/lms/privacy-routes';
import {describe,it,expect} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,lmsInstallations,ltiCredentials} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {privacyAuthorizationContract} from './contracts/privacy-authorization.contract';
import {seedSyncOwner} from './contracts/lms-resource-sync.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL privacy recovery authorization',()=>{
 privacyAuthorizationContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!),execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   await execute((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,lmsInstallations,ltiCredentials}))).map(s=>s.replaceAll('"public".','')).join('\n'));await seedSyncOwner(execute,{connectContext:false,installer:'owner'});
   return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings,execute,credentials:async()=>(await f.pool.query<{kind:string;payload:Record<string,unknown>}>('SELECT kind,payload FROM lti_credentials ORDER BY id')).rows,dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
 it('rejects a JWKS change after verification before reading any personal data',async()=>{
  const f=await isolatedPostgres(url!);try{
   const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
   await execute((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,lmsInstallations,ltiCredentials}))).map(s=>s.replaceAll('"public".','')).join('\n'));await seedSyncOwner(execute,{connectContext:false,installer:'owner'});
   const env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings,registration=await (await createPrivacyAuthorizationRepository(env)).findInstallation({issuer:'https://lms.example',clientId:'client',deploymentId:'2'});if(!registration)throw new Error('missing registration');
   await execute("UPDATE lms_installations SET jwks_url='https://changed.example/keys' WHERE id='school'");
   await expect(executePrivacyRequest(env,registration,{action:'catalog'})).rejects.toMatchObject({status:403});
  }finally{await f.dispose();}
 });

});
