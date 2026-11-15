import {expect,it} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {seedHistory} from './contracts/course-history.contract';
import {materialScope,seedMaterial,materialSrt} from './contracts/material-management.contract';
import {manageLtiMaterial} from '../../src/features/lti/material-management';
import {createD1SceneIndexWriter} from '../../src/persistence/d1/scene-index-writer';
import type {Bindings} from '../../src/types/bindings';
async function setup(){
 const f=await createD1Fixture(),env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{const seeded=await seedHistory(env,execute),fixture={env,execute,...seeded,dispose:f.dispose};await seedMaterial(fixture);return fixture;}catch(error){await f.dispose();throw error;}
}
function beforeCommit(database:D1Database,hook:()=>Promise<void>):D1Database{
 let calls=0;
 return new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(++calls===2)await hook();return target.batch(statements);};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
for(const global of [false,true])it(`refuses mutation during a live ${global?'global':'video'} D1 processing lease`,async()=>{
 const f=await setup();try{
  const scope=materialScope(f),get=()=>manageLtiMaterial(f.env,scope,{action:'get',videoId:scope.videoId}),revision=(await get()).material.revision,jobId=crypto.randomUUID(),type=global?'reindex_all_videos_embeddings':'index_video_transcript';
  if(!global)await f.execute("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',?,'busy')",[JSON.stringify({message:{type,job_id:jobId,payload:{video_id:scope.videoId}}})]);
  await f.execute("INSERT INTO job_executions(job_id,job_type,payload_sha256,status,lease_until) VALUES(?,?,?,'running',?)",[jobId,type,'a'.repeat(64),new Date(Date.now()+60000).toISOString()]);
  await expect(manageLtiMaterial(f.env,scope,{action:'update',videoId:scope.videoId,operationId:crypto.randomUUID(),revision,fields:{description:'Denied'}})).rejects.toMatchObject({status:409});
  expect((await get()).material.description).toBe('');
 }finally{await f.dispose();}
});
it('fences a D1 worker claim acquired immediately before material commit',async()=>{
 const f=await setup();try{
  const database=f.env.DB!,scope=materialScope(f),revision=(await manageLtiMaterial(f.env,scope,{action:'get',videoId:scope.videoId})).material.revision;
  f.env.DB=beforeCommit(database,async()=>{
   const jobId=crypto.randomUUID();await f.execute("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',?,'claimed')",[JSON.stringify({message:{type:'index_video_transcript',job_id:jobId,payload:{video_id:scope.videoId}}})]);
   await f.execute("INSERT INTO job_executions(job_id,job_type,payload_sha256,status,lease_until) VALUES(?,'index_video_transcript',?,'running',?)",[jobId,'a'.repeat(64),new Date(Date.now()+60000).toISOString()]);
  });
  await expect(manageLtiMaterial(f.env,scope,{action:'update',videoId:scope.videoId,operationId:crypto.randomUUID(),revision,fields:{description:'Denied'}})).rejects.toMatchObject({status:409});
  for(const table of ['lti_material_operations','lti_operation_reservations','mutation_receipts'])expect(await database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
 }finally{await f.dispose();}
});
it('invalidates a prepared scene run and persists its vector deletion when the transcript changes',async()=>{
 const f=await setup();try{
  const scope=materialScope(f),writer=createD1SceneIndexWriter(f.env.DB!),source=await writer.readSource(scope.videoId,'owner');if(!source)throw new Error('missing source');
  expect(await writer.start({runId:'old-run',videoId:scope.videoId,userId:'owner',sourceRevision:source.sourceRevision,dimensions:1536,expectedScenes:1})).toBe(true);
  expect(await writer.stage('old-run','owner',[{id:'old-scene',content:'Original',startTime:'00:00:00',endTime:'00:00:01',embedding:Array.from({length:1536},(_,i)=>i===0?1:0)}])).toBe(true);
  const revision=(await manageLtiMaterial(f.env,scope,{action:'get',videoId:scope.videoId})).material.revision;
  await manageLtiMaterial(f.env,scope,{action:'update',videoId:scope.videoId,operationId:crypto.randomUUID(),revision,fields:{transcript:materialSrt.replace('Original','Edited')}});
  expect((await writer.readSource(scope.videoId,'owner'))?.sourceRevision).not.toBe(source.sourceRevision);expect(await writer.publish('old-run','owner')).toBe(false);
  expect(await f.env.DB!.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE operation='delete'").first('n')).toBe(1);
 }finally{await f.dispose();}
});
it('rejects a transcript beyond the D1 row budget without consuming its operation',async()=>{
 const f=await setup();try{
  const scope=materialScope(f),revision=(await manageLtiMaterial(f.env,scope,{action:'get',videoId:scope.videoId})).material.revision;
  await expect(manageLtiMaterial(f.env,scope,{action:'update',videoId:scope.videoId,operationId:crypto.randomUUID(),revision,fields:{transcript:materialSrt.replace('Original','a'.repeat(1_800_001))}})).rejects.toMatchObject({status:413});
  expect(await f.env.DB!.prepare('SELECT count(*) AS n FROM lti_operation_reservations').first('n')).toBe(0);
  expect((await manageLtiMaterial(f.env,scope,{action:'get',videoId:scope.videoId})).material.transcript).toBe(materialSrt);
 }finally{await f.dispose();}
});
