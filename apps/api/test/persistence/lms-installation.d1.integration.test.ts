import {createD1Fixture} from './d1-fixture';
import {lmsInstallationContract} from './contracts/lms-installation.contract';
import type {Bindings} from '../../src/types/bindings';
lmsInstallationContract('D1 workerd',async()=>{
 const f=await createD1Fixture();const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{
  for(const id of ['owner','other'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)',[id,id,`${id}@example.test`]);
  return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud',USE_S3_STORAGE:'true',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url'),LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]})} as Bindings,execute,
   count:async(table:string)=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),
   hash:async(id:string)=>f.database.prepare('SELECT sync_token_hash FROM lms_installations WHERE id=?').bind(id).first<string>('sync_token_hash'),
   failDisconnect:()=>execute("CREATE TRIGGER fail_disconnect BEFORE DELETE ON lti_credentials WHEN OLD.kind='moodle-pairing' BEGIN SELECT RAISE(ABORT,'injected revoke'); END"),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
});
