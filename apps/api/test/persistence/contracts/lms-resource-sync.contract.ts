import {features} from '../../../src/lib/deployment';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {syncLmsResource,getLmsResource} from '../../../src/repositories/lms-resource-repository';
import {resourceManifestSchema,type ResourceManifest} from '../../../src/features/lms/resource';
import type {Bindings} from '../../../src/types/bindings';
type Fixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;count:(table:string)=>Promise<number>;quota:()=>Promise<{storage:number;upload:number}>;
 tasks:()=>Promise<Array<{kind:string;payload:Record<string,unknown>;dedupeKey:string;availableAt:string}>>;members:(courseId:number)=>Promise<number[]>;failCommit:()=>Promise<void>;dispose:()=>Promise<void>};
export async function seedSyncOwner(execute:Fixture['execute'],options:{connectContext?:boolean;installer?:string}={}){
 for(const id of ['owner','other','installer'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes,monthly_upload_limit_gb) VALUES(?,?,?,false,0,0,0,0,NULL)',[id,id,`${id}@example.test`]);
 await execute(`INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,materials_service,active)
  VALUES('school',?,'School','https://lms.example','client','2','https://lms.example/auth','https://lms.example/jwks',?,true)`,[options.installer??'installer',JSON.stringify({tokenEndpoint:'https://lms.example/token',endpoint:'https://lms.example/materials'})]);
 if(options.connectContext!==false)await seedSyncContext(execute);
}
/** Legacy push fixtures explicitly preserve a teacher-owned managed context. */
export async function seedSyncContext(execute:Fixture['execute'],contextId='context',courseId=100,ownerUserId='owner'){
 await execute("INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at,managed_by_lms,native_access_disabled) VALUES(?,?,'LMS course','',0,'2026-11-13','2026-11-13',true,true)",[courseId,ownerUserId]);
 await execute('INSERT INTO lms_courses(id,installation_id,context_id,course_id) VALUES(?,?,?,?)',[crypto.randomUUID(),'school',contextId,courseId]);
 await execute("INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,owner_user_id,course_id) VALUES(?,'moodle','school',?,'fixture-teacher',?,?)",[crypto.randomUUID(),contextId,ownerUserId,courseId]);

}
export function lmsResourceSyncContract(name:string,setup:()=>Promise<Fixture>){
 describe(`${name} LMS synchronization contract`,()=>{
  let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
  const grant={id:'school',ownerUserId:'owner'};
  const manifest=(overrides:Partial<ResourceManifest>={})=>resourceManifestSchema.parse({generation:1,contextId:'context',resourceLinkId:'source',enabled:true,title:'Video',file:{filename:'video.mp4',contentType:'video/mp4',size:100,contentHash:'a'.repeat(64)},...overrides});
  const sync=(m=manifest(),id='source')=>syncLmsResource(f.env,grant,id,m);
  const read=(id='source')=>getLmsResource(f.env,grant,id);
  const entry=(generation=1)=>resourceManifestSchema.parse({generation,contextId:'context',resourceLinkId:'entry',kind:'course',enabled:true,title:'entry',courseTitle:'Entry title'});
  const yt=(generation=1,youtubeVideoId='abcdefghijk')=>resourceManifestSchema.parse({generation,contextId:'context',resourceLinkId:'youtube',kind:'youtube',enabled:true,title:'YouTube',youtubeVideoId});
  it('atomically creates one upload and quota reservation in the preconnected teacher course',async()=>{
   const result=await sync();expect(result).toMatchObject({kind:'video',enabled:true,generation:1,syncError:null,fileSize:100});expect(result.updatedAt).toMatch(/Z$/);
   const data=await read();expect(data).toMatchObject({video:{managedByLms:true,status:'uploading',sourceType:'uploaded',title:'Video'}});
   expect(await f.quota()).toEqual({storage:100,upload:100});expect(await f.members(result.courseId!)).toEqual([result.videoId]);
   expect(await f.count('videos')).toBe(1);expect(await f.count('video_courses')).toBe(1);expect(await f.count('external_tasks')).toBe(0);
  });
  it('rejects invalid reservation sizes without allocating or changing counters',async()=>{
   const m=manifest();await expect(syncLmsResource(f.env,grant,'invalid',{...m,file:{...m.file!,size:-1}})).rejects.toThrow('positive safe integer');
   expect(await f.count('videos')).toBe(0);expect(await f.count('lms_resources')).toBe(0);expect(await f.quota()).toEqual({storage:0,upload:0});
  });
  it('replays identical generations concurrently without allocating twice',async()=>{
   const results=await Promise.all([sync(),sync()]);expect(results[0]).toEqual(results[1]);expect(await sync()).toEqual(results[0]);
   expect(await f.count('videos')).toBe(1);expect(await f.quota()).toEqual({storage:100,upload:100});
  });
  it('shares one context mapping across simultaneous independent resources',async()=>{
   const results=await Promise.all([sync(),sync(manifest({resourceLinkId:'second'}),'second')]);
   expect(results[0].courseId).toBe(results[1].courseId);expect(await f.count('video_courses')).toBe(1);expect(await f.count('lms_courses')).toBe(1);expect(await f.quota()).toEqual({storage:200,upload:200});
  });
  it('rejects stale generations and immutable source kinds',async()=>{
   await sync(manifest({generation:2}));await expect(sync(manifest())).rejects.toMatchObject({status:409,code:'STALE_GENERATION'});
   await expect(sync(manifest({generation:2,title:'different'}))).rejects.toMatchObject({status:409,code:'STALE_GENERATION'});
   await expect(sync(entry(3))).rejects.toMatchObject({status:409,code:'RESOURCE_KIND_OR_CONTEXT_CHANGED'});expect((await read())?.resource.generation).toBe(2);
  });
  it('keeps media and quota for metadata-only updates and locks upload-time language',async()=>{
   const first=await sync(manifest({transcriptionLanguage:'en'}));const renamed=await sync(manifest({generation:2,title:'Renamed',transcriptionLanguage:'en'}));
   expect(renamed.videoId).toBe(first.videoId);expect((await read())?.video?.title).toBe('Renamed');expect(await f.quota()).toEqual({storage:100,upload:100});
   await expect(sync(manifest({generation:3,transcriptionLanguage:'ja'}))).rejects.toMatchObject({status:409,code:'TRANSCRIPTION_LANGUAGE_LOCKED'});
  });
  it('temporarily disables membership, reuses the source and then deletes through durable cleanup',async()=>{
   const first=await sync();await sync(manifest({generation:2,enabled:false,file:undefined}));expect(await f.members(first.courseId!)).toEqual([]);expect((await read())?.video?.id).toBe(first.videoId);
   expect((await sync(manifest({generation:3}))).videoId).toBe(first.videoId);
   const deleted=await sync(manifest({generation:4,enabled:false,deleted:true,file:undefined}));expect(deleted.videoId).toBeNull();expect(deleted.contentHash).toBeNull();
   expect(await f.count('videos')).toBe(0);expect(await f.count('video_courses')).toBe(1);expect(await f.quota()).toEqual({storage:100,upload:0});
   const tasks=await f.tasks();expect(tasks.map(t=>t.dedupeKey).sort()).toEqual([`storage:video:${first.videoId}`,`storage:video:${first.videoId}:late-upload`].sort());
   const late=tasks.find(t=>t.dedupeKey.endsWith(':late-upload'))!;expect(late.payload.bytes).toBeNull();expect(Date.parse(late.availableAt)).toBeGreaterThan(Date.now()+119*60_000);
  });
  it('replaces changed content and refunds only unconfirmed monthly usage',async()=>{
   const first=await sync();const second=await sync(manifest({generation:2,file:{filename:'new.mp4',contentType:'video/mp4',size:200,contentHash:'b'.repeat(64)}}));
   expect(second.videoId).not.toBe(first.videoId);expect(second.courseId).toBe(first.courseId);expect(await f.count('videos')).toBe(1);expect(await f.quota()).toEqual({storage:300,upload:200});expect(await f.count('external_tasks')).toBe(2);
  });
  it('blocks storage/monthly overuse without partial allocation and retries blocked generations',async()=>{
   await f.execute('UPDATE users SET monthly_upload_limit_gb=? WHERE id=?',[100/1073741824,'owner']);await sync();
   const blockedManifest=manifest({resourceLinkId:'second',file:{filename:'x.mp4',contentType:'video/mp4',size:1,contentHash:'b'.repeat(64)}});
   const blocked=await sync(blockedManifest,'second');expect(blocked).toMatchObject({videoId:null,syncError:'MONTHLY_UPLOAD_LIMIT_EXCEEDED'});expect(await f.quota()).toEqual({storage:100,upload:100});
   await f.execute('UPDATE users SET monthly_upload_limit_gb=NULL WHERE id=?',['owner']);expect((await sync(blockedManifest,'second')).videoId).not.toBeNull();expect(await f.quota()).toEqual({storage:101,upload:101});
  });
  it('retains the preconnected course and does not allocate video or quota when storage is exhausted',async()=>{
   await f.execute('UPDATE users SET storage_limit_gb=? WHERE id=?',[99/1073741824,'owner']);expect(await sync()).toMatchObject({videoId:null,courseId:100,syncError:'STORAGE_LIMIT_EXCEEDED'});
   expect(await f.count('videos')).toBe(0);expect(await f.count('video_courses')).toBe(1);expect(await f.quota()).toEqual({storage:0,upload:0});
   await f.execute("UPDATE users SET storage_limit_gb=NULL,is_over_quota=true WHERE id='owner'");expect(await sync(manifest({generation:2}))).toMatchObject({videoId:null,syncError:'STORAGE_LIMIT_EXCEEDED'});
  });
  it('rolls monthly usage forward and never refunds an old period into the current one',async()=>{
   await f.execute("UPDATE users SET upload_usage_period_start='2000-01-01',used_upload_bytes=500 WHERE id='owner'");const first=await sync();expect(await f.quota()).toEqual({storage:100,upload:100});
   await f.execute('UPDATE videos SET upload_usage_period_start=? WHERE id=?',['2000-01-01',first.videoId]);
   await sync(manifest({generation:2,file:{filename:'new.mp4',contentType:'video/mp4',size:200,contentHash:'b'.repeat(64)}}));expect(await f.quota()).toEqual({storage:300,upload:300});
  });
  it('replaces errored material on a new generation and clears native creation receipts',async()=>{
   const first=await sync();await f.execute('UPDATE videos SET status=? WHERE id=?',['error',first.videoId]);
   await f.execute('INSERT INTO mcp_idempotency_records(user_id,action,key,request_hash,resource_id,created_at) VALUES(?,?,?,?,?,?)',['owner','request_video_upload','legacy','a'.repeat(64),first.videoId,new Date().toISOString()]);
   const next=await sync(manifest({generation:2}));expect(next.videoId).not.toBe(first.videoId);expect((await read())?.video?.status).toBe('uploading');
   expect(await f.quota()).toEqual({storage:200,upload:200});expect(await f.count('mcp_idempotency_records')).toBe(0);
  });
  it('creates YouTube jobs without upload/storage admission and preserves idempotence',async()=>{
   if(!features(f.env).youtube)await expect(sync(yt(),'youtube')).rejects.toMatchObject({status:403,code:'YOUTUBE_DISABLED'});
   const syncYoutube=(m:ResourceManifest)=>syncLmsResource({...f.env,DEPLOYMENT_EDITION:'cloud'},grant,'youtube',m);
   const first=await syncYoutube(yt());expect((await read('youtube'))?.video).toMatchObject({status:'pending',file:'',sourceType:'youtube',youtubeVideoId:'abcdefghijk'});
   expect(await f.quota()).toEqual({storage:0,upload:0});expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(1);expect((await f.tasks())[0].payload).toMatchObject({message:{payload:{video_id:first.videoId}}});expect((await syncYoutube(yt())).videoId).toBe(first.videoId);
   const replaced=await syncYoutube(yt(2,'123456789ab'));expect(replaced.videoId).not.toBe(first.videoId);expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(2);
  });
  it('creates course entries without media and keeps their title authoritative',async()=>{
   const first=await sync(entry(),'entry');expect(first.videoId).toBeNull();expect(await f.count('videos')).toBe(0);expect(await f.quota()).toEqual({storage:0,upload:0});
   const video=await sync(manifest({courseTitle:'Video title'}));expect(video.courseId).toBe(first.courseId);expect(await f.count('video_courses')).toBe(1);
   await seedSyncContext(f.execute,'other',101);
   await expect(sync({...entry(2),contextId:'other'},'entry')).rejects.toMatchObject({status:409,code:'RESOURCE_KIND_OR_CONTEXT_CHANGED'});
   await sync({...entry(2),enabled:false},'entry');expect(await f.members(first.courseId!)).toEqual([video.videoId]);
  });
  it('refuses deletion of shared media and retains all state',async()=>{
   const first=await sync();await f.execute(`INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at) VALUES(999,'owner','native','',9,'2026-11-13','2026-11-13')`);
   await f.execute('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(999,?,0,?)',[first.videoId,'2026-11-13']);
   await expect(sync(manifest({generation:2,enabled:false,deleted:true,file:undefined}))).rejects.toMatchObject({status:409,code:'SHARED_MATERIAL'});
   expect((await read())?.resource.generation).toBe(1);expect(await f.quota()).toEqual({storage:100,upload:100});expect(await f.count('external_tasks')).toBe(0);
  });
  it('moves membership and removes the previous course vocabulary without reuploading',async()=>{
   const first=await sync(),tag=crypto.randomUUID();await f.execute('INSERT INTO lti_course_tags(id,course_id,name,color,revision) VALUES(?,?,?,?,?)',[tag,first.courseId,'tag','#123456',crypto.randomUUID()]);
   await f.execute('INSERT INTO lti_course_video_tags(tag_id,video_id) VALUES(?,?)',[tag,first.videoId]);
   await seedSyncContext(f.execute,'next',101);
   const moved=await sync(manifest({generation:2,contextId:'next'}));expect(moved.videoId).toBe(first.videoId);expect(moved.courseId).not.toBe(first.courseId);
   expect(await f.members(first.courseId!)).toEqual([]);expect(await f.members(moved.courseId!)).toEqual([moved.videoId]);expect(await f.count('lti_course_video_tags')).toBe(0);expect(await f.quota()).toEqual({storage:100,upload:100});
  });
  it('repairs owned legacy provenance but refuses a foreign source or course binding',async()=>{
   const first=await sync();await f.execute('UPDATE videos SET managed_by_lms=false WHERE id=?',[first.videoId]);await f.execute('UPDATE video_courses SET managed_by_lms=false,native_access_disabled=false WHERE id=?',[first.courseId]);
   expect((await sync()).videoId).toBe(first.videoId);expect((await read())?.video?.managedByLms).toBe(true);
   await f.execute('UPDATE videos SET user_id=? WHERE id=?',['other',first.videoId]);await expect(sync(manifest({generation:2}))).rejects.toMatchObject({status:409,code:'RESOURCE_BINDING_CHANGED'});
   await f.execute('UPDATE videos SET user_id=? WHERE id=?',['owner',first.videoId]);await f.execute('UPDATE video_courses SET user_id=? WHERE id=?',['other',first.courseId]);
   await expect(sync(manifest({generation:2}))).rejects.toMatchObject({status:409,code:'COURSE_BINDING_CHANGED'});
  });
  it('rechecks grant ownership and revocation without modifying quota',async()=>{
   await expect(syncLmsResource(f.env,{...grant,ownerUserId:'other'},'source',manifest())).rejects.toMatchObject({status:403});
   await f.execute("UPDATE lms_installations SET active=false WHERE id='school'");await expect(sync()).rejects.toMatchObject({status:403});expect(await f.quota()).toEqual({storage:0,upload:0});
  });
  it('derives the charged teacher independently of installer state and refuses absent, native-linked or revoked contexts',async()=>{
   await f.execute("UPDATE users SET is_active=false,banned=true WHERE id='installer'");
   const result=await syncLmsResource(f.env,{id:'school'},'source',manifest());expect(result.courseId).toBe(100);
   expect(await getLmsResource(f.env,{id:'school'},'source')).toMatchObject({ownerUserId:'owner',video:{userId:'owner'}});
   expect(await f.quota()).toEqual({storage:100,upload:100});
   await expect(syncLmsResource(f.env,{id:'school'},'unknown',manifest({contextId:'unconnected'}))).rejects.toMatchObject({code:'TEACHER_CONNECTION_REQUIRED'});
   await f.execute('UPDATE teaching_connections SET resource_link_id=?',['native-entry']);
   await expect(sync(manifest({generation:2}))).rejects.toMatchObject({code:'TEACHER_CONNECTION_REQUIRED'});
   await f.execute('UPDATE teaching_connections SET resource_link_id=NULL,active=false');
   await expect(sync(manifest({generation:2}))).rejects.toMatchObject({code:'TEACHER_CONNECTION_REQUIRED'});
   expect(await f.quota()).toEqual({storage:100,upload:100});
  });
  it('serializes concurrent generations and never overwrites the newest state',async()=>{
   await sync();const results=await Promise.allSettled([sync(manifest({generation:2,title:'second'})),sync(manifest({generation:3,title:'third'}))]);
   expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(await read()).toMatchObject({resource:{generation:3},video:{title:'third'}});expect(await f.quota()).toEqual({storage:100,upload:100});
  });
  it('rolls back replacement, quota refunds and outboxes if final persistence fails',async()=>{
   const first=await sync();await f.failCommit();await expect(sync(manifest({generation:2,file:{filename:'new.mp4',contentType:'video/mp4',size:200,contentHash:'b'.repeat(64)}}))).rejects.toThrow();
   expect(await read()).toMatchObject({resource:{generation:1,videoId:first.videoId},video:{id:first.videoId}});expect(await f.quota()).toEqual({storage:100,upload:100});expect(await f.count('external_tasks')).toBe(0);
  });
 });
}
