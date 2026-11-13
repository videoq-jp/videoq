import * as resources from '../../src/repositories/lms-resource-repository';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {seedSyncOwner,seedSyncContext} from './contracts/lms-resource-sync.contract';
import {ensureManagedToolKeys} from '../../src/features/lti/tool-keys';
import {synchronizeMaterials,sweepMaterials} from '../../src/features/lti/materials-sync';
import {materialStateKey} from '../../src/features/lms/material-state-key';
import {createMaterialsSyncRepository} from '../../src/persistence/factory';
import {getLmsResource} from '../../src/repositories/lms-resource-repository';
import type {Bindings} from '../../src/types/bindings';
vi.mock('../../src/lib/external-tasks',async original=>({...await original<typeof import('../../src/lib/external-tasks')>(),processExternalTaskById:vi.fn()}));
let f:Awaited<ReturnType<typeof createD1Fixture>>,env:Bindings;
const service={tokenEndpoint:'https://lms.example/token',endpoint:'https://lms.example/materials'};
const source={externalId:'source',manifest:{generation:1,contextId:'context',resourceLinkId:'activity',enabled:true,title:'Video',file:{filename:'video.mp4',size:100,contentType:'video/mp4',contentHash:'a'.repeat(64)}}};
beforeEach(async()=>{
 f=await createD1Fixture();await seedSyncOwner(async(sql,args=[])=>{await f.database.prepare(sql).bind(...args).run();});
 env={DB:f.database,DEPLOYMENT_EDITION:'cloud',ENVIRONMENT:'production',USE_S3_STORAGE:'true',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url'),
  R2_ACCESS_KEY_ID:'fixture',R2_SECRET_ACCESS_KEY:'fixture',R2_S3_ENDPOINT:'https://storage.example',R2_BUCKET_NAME:'bucket',
  LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]}),VIDEO_BUCKET:{head:()=>Promise.resolve({size:100})},
  TASK_SCHEDULER:{getByName:()=>({armAt:()=>Promise.resolve()})}} as unknown as Bindings;
 await ensureManagedToolKeys(env);
});
afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();await f?.dispose();});
function requests(handler:(body:Record<string,unknown>)=>Promise<Response>|Response){
 vi.stubGlobal('fetch',(input:unknown,init:RequestInit)=>{
  if(input===service.tokenEndpoint)return Promise.resolve(Response.json({access_token:'fixture',token_type:'Bearer',expires_in:60,scope:'https://videoq.org/spec/lti-materials/v1'}));
  expect(input).toBe(service.endpoint);if(typeof init.body!=='string')throw new Error('Unexpected request body');return handler(JSON.parse(init.body) as Record<string,unknown>);
 });
}
const manifest=()=>Response.json({contextId:'context',complete:true,resources:[source]});
const status=(state='queued')=>Response.json({jobId:'job',generation:1,status:state,...(state==='uploaded'?{bytes:100}:{})});
describe('shared materials orchestration on workerd D1',()=>{
 it('does not confirm or enqueue when the lease expires during storage verification',async()=>{
  requests(body=>{if(body.action==='manifest')return manifest();if(body.action==='export')return status('uploaded');throw new Error('Unexpected action');});
  env.VIDEO_BUCKET={head:async()=>{
   await f.database.prepare("UPDATE lti_credentials SET expires_at='2000-01-01' WHERE kind='materials-lease'").run();return {size:100};
  }} as unknown as R2Bucket;
  await expect(synchronizeMaterials(env,'school','context')).rejects.toThrow('lease');
  expect(await getLmsResource(env,{id:'school',ownerUserId:'owner'},'source')).toMatchObject({video:{status:'uploading'}});
  expect(await f.database.prepare("SELECT count(*) AS n FROM external_tasks WHERE kind='sqs_job'").first('n')).toBe(0);
 });
 it('does not confirm an upload replaced during storage verification',async()=>{
  requests(body=>{if(body.action==='manifest')return manifest();if(body.action==='export')return status('uploaded');throw new Error('Unexpected action');});
  env.VIDEO_BUCKET={head:async()=>{
   await resources.syncLmsResource(env,{id:'school',ownerUserId:'owner'},'source',{...source.manifest,generation:2,file:{...source.manifest.file,contentHash:'b'.repeat(64)}});return {size:100};
  }} as unknown as R2Bucket;
  await expect(synchronizeMaterials(env,'school','context')).rejects.toThrow('lease');
  expect(await getLmsResource(env,{id:'school',ownerUserId:'owner'},'source')).toMatchObject({resource:{generation:2},video:{status:'uploading'}});
  expect(await f.database.prepare("SELECT count(*) AS n FROM external_tasks WHERE kind='sqs_job'").first('n')).toBe(0);
 });
 it('keeps an invalid object unconfirmed without deleting the current reservation',async()=>{
  requests(body=>{if(body.action==='manifest')return manifest();if(body.action==='export')return status('uploaded');throw new Error('Unexpected action');});
  env.VIDEO_BUCKET={head:()=>Promise.resolve({size:99})} as unknown as R2Bucket;
  await expect(synchronizeMaterials(env,'school','context')).rejects.toThrow('size mismatch');
  expect(await getLmsResource(env,{id:'school',ownerUserId:'owner'},'source')).toMatchObject({video:{status:'uploading'},resource:{generation:1,enabled:true}});
  expect(await f.database.prepare("SELECT count(*) AS n FROM external_tasks WHERE kind='sqs_job'").first('n')).toBe(0);
 });
 it('resumes a stored platform job, confirms actual storage and emits one durable processing job',async()=>{
  let exports=0,statusChecks=0;
  requests(body=>{if(body.action==='manifest')return manifest();if(body.action==='export'){exports++;expect(body.idempotencyKey).toBeTypeOf('string');expect(body.uploadUrl).toContain('https://storage.example/');return status();}if(body.action==='status'){statusChecks++;return status('uploaded');}if(body.action==='ack')return Response.json({acknowledged:true});throw new Error('Unexpected action');});
  expect(await synchronizeMaterials(env,'school','context')).toEqual({busy:false,pending:true});
  expect(await synchronizeMaterials(env,'school','context')).toEqual({busy:false,pending:true});expect(exports).toBe(1);expect(statusChecks).toBe(1);
  expect(await getLmsResource(env,{id:'school',ownerUserId:'owner'},'source')).toMatchObject({video:{status:'pending'}});
  expect(await f.database.prepare("SELECT count(*) AS n FROM external_tasks WHERE kind='sqs_job'").first('n')).toBe(1);
 });
 it('reuses the persisted idempotency attempt after the export response is lost',async()=>{
  const attempts:unknown[]=[];
  requests(body=>{if(body.action==='manifest')return manifest();if(body.action==='export'){attempts.push(body.idempotencyKey);if(attempts.length===1)throw new Error('response lost');return status();}throw new Error('Unexpected action');});
  await expect(synchronizeMaterials(env,'school','context')).rejects.toThrow('response lost');await synchronizeMaterials(env,'school','context');
  expect(attempts).toHaveLength(2);expect(attempts[0]).toBe(attempts[1]);
 });
 it('does not save a late job response after another worker reclaims the context lease',async()=>{
  let replacement:string|undefined;
  requests(async body=>{
   if(body.action==='manifest')return manifest();
   if(body.action==='export'){
    const id=await materialStateKey('lti-materials-lease:','school','context');await f.database.prepare('UPDATE lti_credentials SET expires_at=? WHERE id=?').bind('2000-01-01',id).run();
    const repo=await createMaterialsSyncRepository(env),claimed=await repo.claimContext('school',id,crypto.randomUUID());if(claimed.status!=='claimed')throw new Error('reclaim failed');replacement=claimed.lease.token;
    const key=await materialStateKey('lti-export:','school','source',1);await repo.prepareExport(claimed.lease,key,'context','ignored');await repo.saveExportJob(claimed.lease,key,(await repo.prepareExport(claimed.lease,key,'context','ignored')).attempt,'new-job');
    return status();
   }
   throw new Error('Unexpected action');
  });
  await expect(synchronizeMaterials(env,'school','context')).rejects.toThrow('lease');
  const key=await materialStateKey('lti-export:','school','source',1),id=await materialStateKey('lti-materials-lease:','school','context');
  expect(JSON.parse((await f.database.prepare('SELECT payload FROM lti_credentials WHERE id=?').bind(key).first<string>('payload'))!).jobId).toBe('new-job');
  expect(JSON.parse((await f.database.prepare('SELECT payload FROM lti_credentials WHERE id=?').bind(id).first<string>('payload'))!).lease).toBe(replacement);
 });
 it('does not export a newer video using an older manifest after a concurrent resync',async()=>{
  let exports=0;
  requests(body=>{if(body.action==='manifest')return manifest();if(body.action==='export'){exports++;return status();}throw new Error('Unexpected action');});
  const original=resources.getLmsResource;
  vi.spyOn(resources,'getLmsResource').mockImplementationOnce(async(...args)=>{
   await resources.syncLmsResource(env,{id:'school',ownerUserId:'owner'},'source',{...source.manifest,generation:2,file:{...source.manifest.file,size:200,contentHash:'b'.repeat(64)}});
   return original(...args);
  });
  expect(await synchronizeMaterials(env,'school','context')).toEqual({busy:false,pending:false});expect(exports).toBe(0);
  expect(await original(env,{id:'school',ownerUserId:'owner'},'source')).toMatchObject({resource:{generation:2,fileSize:200},video:{status:'uploading'}});
 });
 it('polls sorted contexts with a durable cursor without using a learner session',async()=>{
  await seedSyncContext(async(sql,args=[])=>{await f.database.prepare(sql).bind(...args).run();},'z',101);
  const contexts:unknown[]=[];
  requests(body=>{if(body.action==='courses')return Response.json({contextIds:['z','context','context']});if(body.action==='manifest'){contexts.push(body.contextId);return Response.json({contextId:body.contextId,complete:true,resources:[]});}throw new Error('Unexpected action');});
  expect(await sweepMaterials(env)).toEqual({synchronized:1});expect(contexts).toEqual(['context']);expect(await f.database.prepare('SELECT materials_cursor FROM lms_installations').first('materials_cursor')).toBe(1);
  await f.database.prepare("UPDATE lms_installations SET next_materials_sync_at='2000-01-01'").run();expect(await sweepMaterials(env)).toEqual({synchronized:1});expect(contexts).toEqual(['context','z']);
 });
});
