import { describe } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { users, apikey, oauthClient, oauthConsent } from '../../src/db/schema';
import { accountIntegrationsContract } from './contracts/account-integrations.contract';
import { isolatedPostgres } from './isolated-postgres';
import type { Bindings } from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL integration metadata',()=>{
  accountIntegrationsContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);
    try{
      await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,apikey,oauthClient,oauthConsent}))).map(s=>s.replaceAll('"public".','')).join('\n'));
      return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings,
        execute:async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);},dispose:f.dispose};
    }catch(error){await f.dispose();throw error;}
  });
});
