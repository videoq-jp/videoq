import {createD1Fixture} from './d1-fixture';
import {credentialContract} from './contracts/credential.contract';
import {createCredentialRepository} from '../../src/persistence/factory';
import type {Bindings} from '../../src/types/bindings';
credentialContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
  try{
    await execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',0,0,0,0)");
    await execute("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'owner','course','','2026-11-13','2026-11-13',0)");
    const env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
    return {env,repository:await createCredentialRepository(env),execute,
      expiry:async(id:string)=>{const value=await f.database.prepare('SELECT expires_at FROM lti_credentials WHERE id=?').bind(id).first<string>('expires_at');return value?Date.parse(value):null;},
      count:async()=>Number(await f.database.prepare('SELECT count(*) AS n FROM lti_credentials').first('n')),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
});
