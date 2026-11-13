import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {createD1VideoUploadRepository} from '../../src/persistence/d1/video-upload-repository';
import {createD1WorkerAccountDeletion} from '../../src/persistence/d1/worker-account-deletion';
import {createD1AdminUserRepository} from '../../src/persistence/d1/admin-user-repository';
import {createD1JobRepository} from '../../src/persistence/d1/job-repository';
import {buildPendingUploadFileKey} from '../../src/lib/upload';
import {workerInternalRoutes} from '../../src/features/worker-internal/routes';
import type {AccountDeletionLease} from '../../src/persistence/contracts/worker-account-deletion';
import type {Bindings} from '../../src/types/bindings';
describe('D1 cloud account deletion',()=>{
 let f:Awaited<ReturnType<typeof createD1Fixture>>,grant:AccountDeletionLease,env:Bindings,videoId:number;
 beforeEach(async()=>{
  f=await createD1Fixture();env={DB:f.database,DEPLOYMENT_EDITION:'cloud',RUNTIME:'node',WORKER_INTERNAL_API_SECRET:'worker-delete-secret-012345678901234567890'} as Bindings;
  for(const id of ['owner','peer'])await f.database.prepare('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)').bind(id,id,id+'@example.test').run();
  const uploaded=await createD1VideoUploadRepository(f.database).reserveUpload({userId:'owner',storageBytes:5,fileKey:buildPendingUploadFileKey('owner',5,'.mp4'),title:'Lesson',description:''});if(!('ok'in uploaded))throw new Error('seed failed');videoId=uploaded.videoId;
  await f.database.prepare("INSERT INTO scenes(id,video_id,content,start_time,end_time,dimensions,revision) VALUES('scene',?,'private transcript','00:01','00:02',1536,'legacy')").bind(videoId).run();
  const job=await createD1AdminUserRepository(f.database,env).lockForHardDelete('owner');if(!('jobId'in job))throw new Error('seed job failed');
  const claim=await createD1JobRepository(f.database).claim({jobId:job.jobId,jobType:'delete_account_data',payloadSha256:'a'.repeat(64)});if(claim.status!=='claimed')throw new Error('seed claim failed');grant={userId:'owner',jobId:job.jobId,leaseToken:claim.leaseToken};
 });
 afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
 const repository=()=>createD1WorkerAccountDeletion(f.database,async()=>{});
 const count=async(table:string)=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n'));
 it('deletes media pointers with durable storage/vector cleanup before removing the user, preserving other owners',async()=>{
  await f.database.prepare("INSERT INTO apikey(id,reference_id,key) VALUES('key','owner','private-hash'),('peer-key','peer','peer-hash')").run();
  await f.database.prepare("INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES('credential','pairing',?, '2099-01-01')").bind(JSON.stringify({ownerUserId:'owner',secret:'private'})).run();
  expect(await repository().step(grant)).toEqual({status:'progress'});expect(await count('videos')).toBe(0);expect(await count('users')).toBe(2);
  expect(await f.database.prepare("SELECT file_key FROM (SELECT json_extract(payload,'$.file_key') AS file_key FROM external_tasks WHERE kind='storage_cleanup')").first()).not.toBeNull();expect(await count('scene_index_tasks')).toBe(1);
  expect(await repository().step(grant)).toEqual({status:'completed'});expect(await f.database.prepare("SELECT id FROM users").all()).toMatchObject({results:[{id:'peer'}]});expect(await count('apikey')).toBe(1);expect(await count('lti_credentials')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
  expect(await repository().step(grant)).toEqual({status:'completed'});expect(await count('scene_index_tasks')).toBe(1);
 });
 it('purges NO ACTION business ownership and cascades native auth and conversation memory',async()=>{
  await f.database.prepare("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(1,'Course','','2026-01-01','2026-01-01','owner',0)").run();
  await f.database.prepare("INSERT INTO chat_logs(question,response,is_shared_origin,created_at,user_id,course_id,retrieved_contexts) VALUES('private','{}',0,'2026-01-01','owner',1,'[]')").run();
  await f.database.prepare("INSERT INTO chat_conversations(conversation_id,thread_id,owner_user_id,actor_user_id,course_id,expires_at) VALUES('conversation','thread','owner','owner',1,'2099-01-01')").run();
  await f.database.prepare("INSERT INTO conversation_checkpoints(thread_id,namespace,checkpoint_id,checkpoint_type,checkpoint,metadata_type,metadata) VALUES('thread','','cp','json',X'7B7D','json',X'7B7D')").run();
  await f.database.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES('account','owner','credential','owner','private-password-hash')").run();
  expect(await repository().step(grant)).toEqual({status:'progress'});expect(await repository().step(grant)).toEqual({status:'completed'});
  for(const table of ['video_courses','chat_logs','chat_conversations','conversation_checkpoints','account'])expect(await count(table)).toBe(0);
 });
 it('rolls back final business cleanup if deleting the user root fails',async()=>{
  await repository().step(grant);await f.database.prepare("INSERT INTO tags(name,color,created_at,user_id) VALUES('tag','#fff','2026-01-01','owner')").run();
  await f.database.prepare("CREATE TRIGGER fail_root BEFORE DELETE ON users WHEN OLD.id='owner' BEGIN SELECT RAISE(ABORT,'root failure'); END").run();
  await expect(repository().step(grant)).rejects.toThrow();expect(await count('tags')).toBe(1);expect(await count('users')).toBe(2);expect(await count('mutation_receipts')).toBe(0);
  await f.database.prepare('DROP TRIGGER fail_root').run();expect(await repository().step(grant)).toEqual({status:'completed'});
 });
 it('drains bounded ownership records and resumes with the remaining rows',async()=>{
  await repository().step(grant);
  for(let i=0;i<105;i++)await f.database.prepare("INSERT INTO tags(name,color,created_at,user_id) VALUES(?,'#ffffff','2026-01-01','owner')").bind('tag'+i).run();
  for(let offset=0;offset<105;offset+=25)await f.database.batch(Array.from({length:Math.min(25,105-offset)},(_,i)=>f.database.prepare("INSERT INTO apikey(id,reference_id,key) VALUES(?,'owner','private')").bind('key'+(offset+i))));
  expect(await repository().step(grant)).toEqual({status:'progress'});expect(await count('apikey')).toBe(5);expect(await count('tags')).toBe(5);expect(await count('users')).toBe(2);expect(await repository().step(grant)).toEqual({status:'completed'});expect(await count('tags')).toBe(0);
 });
 it.each(['token','expiry','type','outbox','reactivated','admin','other-user']as const)('refuses an invalid %s grant without deleting data',async(kind)=>{
  if(kind==='token')grant.leaseToken=crypto.randomUUID();
  if(kind==='expiry')await f.database.prepare("UPDATE job_executions SET lease_until='2000-01-01'").run();
  if(kind==='type')await f.database.prepare("UPDATE job_executions SET job_type='transcribe_video'").run();
  if(kind==='outbox')await f.database.prepare("UPDATE external_tasks SET payload='{}'").run();
  if(kind==='reactivated')await f.database.prepare('UPDATE users SET banned=0').run();
  if(kind==='admin')await f.database.prepare("UPDATE users SET role='admin' WHERE id='owner'").run();
  if(kind==='other-user')grant.userId='peer';
  expect(await repository().step(grant)).toEqual({status:'denied'});expect(await count('videos')).toBe(1);expect(await count('scenes')).toBe(1);
 });
 it('rolls back deletion and cleanup tasks on a late failure, then retries safely',async()=>{
  await f.database.prepare("CREATE TRIGGER fail_delete BEFORE DELETE ON videos BEGIN SELECT RAISE(ABORT,'failure'); END").run();await expect(repository().step(grant)).rejects.toThrow();expect(await count('videos')).toBe(1);expect(await count('scene_index_tasks')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
  await f.database.prepare('DROP TRIGGER fail_delete').run();expect(await repository().step(grant)).toEqual({status:'progress'});
 });
 it('rechecks authorization inside the video deletion batch after its snapshot read',async()=>{
  const db=f.database,original=db.batch.bind(db);let injected=false;
  const fenced=new Proxy(db,{get(object,key){if(key!=='batch'){const v=Reflect.get(object,key);return typeof v==='function'?v.bind(object):v;}return async(statements:D1PreparedStatement[])=>{if(!injected){injected=true;await db.prepare("UPDATE users SET banned=0 WHERE id='owner'").run();}return original(statements);};}});
  await expect(createD1WorkerAccountDeletion(fenced,async()=>{}).step(grant)).rejects.toThrow();expect(injected).toBe(true);expect(await count('videos')).toBe(1);expect(await count('scene_index_tasks')).toBe(0);
 });
 it('requires an exact signed request and validates the API input',async()=>{
  const body=JSON.stringify(grant),timestamp=String(Math.floor(Date.now()/1000)),path='/account-delete/step',origin='https://api.example';
  expect((await workerInternalRoutes.request(origin+path,{method:'POST',body},env)).status).toBe(401);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.WORKER_INTERNAL_API_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`videoq-worker-v1\n${timestamp}\nPOST\n${origin}\n${path}\n${body}`))),v=>v.toString(16).padStart(2,'0')).join('');
  const response=await workerInternalRoutes.request(origin+path,{method:'POST',body,headers:{'x-videoq-worker-timestamp':timestamp,'x-videoq-worker-signature':signature}},env);expect(response.status).toBe(200);expect(await response.json()).toEqual({status:'progress'});
 });
});
