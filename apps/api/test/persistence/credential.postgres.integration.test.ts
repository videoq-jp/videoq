import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {credentialContract} from './contracts/credential.contract';
import {createCredentialRepository} from '../../src/persistence/factory';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL credentials',()=>{
  credentialContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);
    const execute=async(sql:string,args:unknown[]=[])=>{let index=0;await f.pool.query(sql.replaceAll('?',()=>`$${++index}`),args);};
    try{
      await execute(`CREATE TABLE users(id text PRIMARY KEY);CREATE TABLE video_courses(id bigint PRIMARY KEY,user_id text REFERENCES users);
        CREATE TABLE lti_credentials(id text PRIMARY KEY,kind text,payload jsonb,expires_at timestamptz);
        INSERT INTO users VALUES('owner');INSERT INTO video_courses VALUES(1,'owner');`);
      const env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
      return {env,repository:await createCredentialRepository(env),execute,
        expiry:async(id:string)=>(await f.pool.query<{expires_at:Date}>('SELECT expires_at FROM lti_credentials WHERE id=$1',[id])).rows[0]?.expires_at.getTime()??null,
        count:async()=>Number((await f.pool.query<{n:string}>('SELECT count(*) AS n FROM lti_credentials')).rows[0].n),dispose:f.dispose};
    }catch(error){await f.dispose();throw error;}
  });
});
