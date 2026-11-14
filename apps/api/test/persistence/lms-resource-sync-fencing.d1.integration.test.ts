import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {seedSyncOwner} from './contracts/lms-resource-sync.contract';
import {createD1LmsResourceSyncRepository} from '../../src/persistence/d1/lms-resource-sync';
import {syncLmsResource,getLmsResource} from '../../src/repositories/lms-resource-repository';
import {digest} from '../../src/features/lti/store';
import {resourceManifestSchema} from '../../src/features/lms/resource';
import {createD1SceneIndexWriter} from '../../src/persistence/d1/scene-index-writer';
import type {Bindings} from '../../src/types/bindings';
let f:Awaited<ReturnType<typeof createD1Fixture>>,env:Bindings;
const grant={id:'school',ownerUserId:'owner'};
const manifest=(generation=1,title='Video')=>resourceManifestSchema.parse({generation,contextId:'context',resourceLinkId:'source',enabled:true,title,file:{filename:'video.mp4',contentType:'video/mp4',size:100,contentHash:'a'.repeat(64)}});
beforeEach(async()=>{f=await createD1Fixture();env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;await seedSyncOwner(async(sql,args=[])=>{await f.database.prepare(sql).bind(...args).run();});});
afterEach(async()=>{await f?.dispose();});
function intercept(operation:()=>Promise<void>):D1Database {
 let calls=0;return new Proxy(f.database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(++calls===3)await operation();return target.batch(statements);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
const count=async(table:string)=>f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');
describe('D1 LMS sync atomic fences and index cleanup',()=>{
 it('rejects a revoked installation after preparation without allocating or charging',async()=>{
  const database=intercept(async()=>{await f.database.prepare("UPDATE lms_installations SET active=0 WHERE id='school'").run();});
  const m=manifest();await expect(createD1LmsResourceSyncRepository(database).sync(grant,'source',m,await digest(JSON.stringify(m)))).rejects.toMatchObject({status:403});
  expect(await count('videos')).toBe(0);expect(await count('lms_resources')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
  expect(await f.database.prepare("SELECT used_storage_bytes FROM users WHERE id='owner'").first('used_storage_bytes')).toBe(0);
 });
 it('rereads after a newer generation commits and does not overwrite it',async()=>{
  await syncLmsResource(env,grant,'source',manifest());
  const database=intercept(async()=>{await syncLmsResource(env,grant,'source',manifest(3,'newest'));});
  const stale=manifest(2,'stale');await expect(createD1LmsResourceSyncRepository(database).sync(grant,'source',stale,await digest(JSON.stringify(stale)))).rejects.toMatchObject({status:409,code:'STALE_GENERATION'});
  expect(await getLmsResource(env,grant,'source')).toMatchObject({resource:{generation:3},video:{title:'newest'}});expect(await count('videos')).toBe(1);expect(await count('mutation_receipts')).toBe(0);
 });
 it('uses the latest quota limits when committing prepared allocations',async()=>{
  const database=intercept(async()=>{await f.database.prepare("UPDATE users SET storage_limit_gb=? WHERE id='owner'").bind(99/1073741824).run();});
  const m=manifest();expect(await createD1LmsResourceSyncRepository(database).sync(grant,'source',m,await digest(JSON.stringify(m)))).toMatchObject({videoId:null,syncError:'STORAGE_LIMIT_EXCEEDED'});
  expect(await count('videos')).toBe(0);expect(await count('video_courses')).toBe(1);
 });
 it('rejects a new shared reference added between preparation and deletion',async()=>{
  const first=await syncLmsResource(env,grant,'source',manifest());
  const database=intercept(async()=>{
   await f.database.prepare("INSERT INTO video_courses(id,user_id,name,description,display_order,created_at,updated_at) VALUES(999,'owner','other','',9,'2026-11-13','2026-11-13')").run();
   await f.database.prepare('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(999,?,0,?)').bind(first.videoId,'2026-11-13').run();
  });
  const deletion=resourceManifestSchema.parse({...manifest(2),enabled:false,deleted:true,file:undefined});
  await expect(createD1LmsResourceSyncRepository(database).sync(grant,'source',deletion,await digest(JSON.stringify(deletion)))).rejects.toMatchObject({status:409,code:'SHARED_MATERIAL'});
  expect(await count('videos')).toBe(1);expect(await count('video_course_members')).toBe(2);expect(await count('external_tasks')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
 });
 it('enqueues immutable current and staged vector deletions before cascading source rows',async()=>{
  const first=await syncLmsResource(env,grant,'source',manifest()),videoId=first.videoId!;
  await f.database.prepare("INSERT INTO scenes(id,video_id,content,start_time,end_time,dimensions,revision,vector_id) VALUES('current',?,'text','0','1',768,'old','current-vector')").bind(videoId).run();
  const writer=createD1SceneIndexWriter(f.database),source=(await writer.readSource(videoId,'owner'))!;
  expect(await writer.start({runId:'staged-run',videoId,userId:'owner',sourceRevision:source.sourceRevision,dimensions:768,expectedScenes:1})).toBe(true);
  expect(await writer.stage('staged-run','owner',[{id:'pending',content:'staged',startTime:'0',endTime:'1',embedding:Array.from({length:768},(_,i)=>i===0?1:0)}])).toBe(true);
  await syncLmsResource(env,grant,'source',resourceManifestSchema.parse({...manifest(2),enabled:false,deleted:true,file:undefined}));
  const deletes=(await f.database.prepare("SELECT vector_id FROM scene_index_tasks WHERE operation='delete' ORDER BY vector_id").all<{vector_id:string}>()).results;
  expect(deletes).toHaveLength(2);expect(deletes.map(r=>r.vector_id)).toContain('current-vector');
  expect(await count('scenes')).toBe(0);expect(await count('scene_staging')).toBe(0);expect(await count('videos')).toBe(0);
 });
});
