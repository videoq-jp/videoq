import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {toolKeysContract} from './contracts/tool-keys.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL tool keys',()=>{
  toolKeysContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);
    try{
      await f.pool.query('CREATE TABLE lti_tool_keys(id text PRIMARY KEY,encrypted_key_ring text NOT NULL,created_at timestamptz DEFAULT now())');
      return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url')} as Bindings,
        execute:async(sql:string,args:unknown[]=[])=>{let index=0;await f.pool.query(sql.replaceAll('?',()=>`$${++index}`),args);},
        count:async()=>Number((await f.pool.query<{n:string}>('SELECT count(*) AS n FROM lti_tool_keys')).rows[0].n),dispose:f.dispose};
    }catch(error){await f.dispose();throw error;}
  });
});
