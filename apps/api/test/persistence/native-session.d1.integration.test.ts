import {expect,it} from 'vitest';
import {ensureNativeSession} from '../../src/features/lms/native-session';
import {recordScopeVideos} from '../../src/features/lti/store';
import {nativeInput} from './contracts/native-session.contract';
import {createD1Fixture} from './d1-fixture';
import {nativeSessionContract,type NativeFixture} from './contracts/native-session.contract';
import type {Bindings} from '../../src/types/bindings';
async function setup():Promise<NativeFixture>{
 const f=await createD1Fixture();try{
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',false,0,0,0)").run();
  return {env:{DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings,
   execute:async(sql,args=[])=>{await f.database.prepare(sql).bind(...args).run();},
   rows:async()=>(await f.database.prepare('SELECT id,kind,payload,expires_at AS expiresAt FROM lti_credentials ORDER BY id').all<{id:string;kind:string;payload:string;expiresAt:string}>()).results.map(r=>({...r,payload:JSON.parse(r.payload) as Record<string,unknown>,expiresAt:new Date(r.expiresAt).toISOString()})),dispose:f.dispose};
 }catch(error){await f.dispose();throw error;}
}
nativeSessionContract('D1 workerd',setup);

// Inject a real concurrent DB write between the typed snapshot read and batch.
function beforeNextBatch(database:D1Database,hook:()=>Promise<void>):D1Database{
 let pending=true;
 return new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(pending){pending=false;await hook();}return target.batch(statements);};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}

it('retries a D1 snapshot invalidated by a committed scope union',async()=>{
 const f=await setup();try{
  const input=nativeInput();await ensureNativeSession(f.env,input);
  const original=f.env.DB!;
  f.env.DB=beforeNextBatch(original,async()=>{await recordScopeVideos({...f.env,DB:original},input.sessionHash,[7]);});
  await ensureNativeSession(f.env,{...input,nonceHash:crypto.randomUUID()});
  expect(((await f.rows()).find(r=>r.kind==='session')!.payload.scopeVideoIds as number[]).sort()).toEqual([3,7]);
  expect((await f.rows()).filter(r=>r.kind==='moodle-native-request')).toHaveLength(2);
 }finally{await f.dispose();}
});
it('does not recreate a D1 session revoked after the snapshot read',async()=>{
 const f=await setup();try{
  const input=nativeInput();await ensureNativeSession(f.env,input);
  f.env.DB=beforeNextBatch(f.env.DB!,()=>f.execute('DELETE FROM lti_credentials WHERE id=?',[input.sessionHash]));
  const nonce=crypto.randomUUID();await expect(ensureNativeSession(f.env,{...input,nonceHash:nonce})).rejects.toMatchObject({status:403});
  expect((await f.rows()).some(r=>r.kind==='session'||r.id===nonce)).toBe(false);
 }finally{await f.dispose();}
});
it('rolls back the D1 nonce and marker when the session insert fails',async()=>{
 const f=await setup();try{
  await f.execute("CREATE TRIGGER fail_native BEFORE INSERT ON lti_credentials WHEN NEW.kind='session' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await expect(ensureNativeSession(f.env,nativeInput())).rejects.toThrow('fixture failure');expect(await f.rows()).toHaveLength(0);
 }finally{await f.dispose();}
});
