import {createD1Fixture} from './d1-fixture';
import {moodlePairingContract} from './contracts/moodle-pairing.contract';
import type {Bindings} from '../../src/types/bindings';
moodlePairingContract('D1 workerd',async()=>{
  const f=await createD1Fixture();const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
  try{
    for(const id of ['owner','other'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)',[id,id,`${id}@example.test`]);
    return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud',USE_S3_STORAGE:'true',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url'),LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]})} as Bindings,execute,
      count:async(table:string)=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),
      syncHash:async()=>f.database.prepare('SELECT sync_token_hash FROM lms_installations LIMIT 1').first<string>('sync_token_hash'),
      credential:async(id:string)=>{const row=await f.database.prepare('SELECT kind,payload FROM lti_credentials WHERE id=?').bind(id).first<{kind:string;payload:string}>();return row?{kind:row.kind,payload:JSON.parse(row.payload) as Record<string,unknown>}:null;},
      failIssue:()=>execute("CREATE TRIGGER fail_issue BEFORE INSERT ON lti_credentials WHEN NEW.kind='moodle-pairing' BEGIN SELECT RAISE(ABORT,'injected issue'); END"),
      failExchange:()=>execute("CREATE TRIGGER fail_exchange BEFORE INSERT ON lti_credentials WHEN NEW.kind='materials-pairing' BEGIN SELECT RAISE(ABORT,'injected exchange'); END"),
      allowExchange:()=>execute('DROP TRIGGER fail_exchange'),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
});
