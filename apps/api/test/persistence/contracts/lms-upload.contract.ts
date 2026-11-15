import {seedSyncContext} from './lms-resource-sync.contract';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {lmsRoutes} from '../../../src/features/lms/routes';
import {lmsUploadSnapshot,uploadLmsContent,confirmLmsUpload} from '../../../src/features/lms/content-upload';
import {getLmsResource,syncLmsResource} from '../../../src/repositories/lms-resource-repository';
import {resourceManifestSchema} from '../../../src/features/lms/resource';
import {createLmsUploadRepository} from '../../../src/persistence/factory';
import {buildPendingUploadFileKey} from '../../../src/lib/upload';
import {contentSlot} from '../../../src/shared/lms-upload';
import {processExternalTasks} from '../../../src/lib/external-tasks';
import type {Bindings,AppEnv} from '../../../src/types/bindings';
import type {LmsUploadSnapshot} from '../../../src/persistence/contracts/lms-upload-repository';
export const uploadManifest=(generation=1,enabled=true)=>resourceManifestSchema.parse({generation,contextId:'course',resourceLinkId:'source',enabled,title:'Video',file:{filename:'video.mp4',size:3,contentType:'video/mp4',contentHash:'a'.repeat(64)}});
export const uploadGrant={id:'school',ownerUserId:'owner'};
export type UploadFixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;tasks:()=>Promise<Array<{id:number;kind:string;payload:Record<string,unknown>}>>;quota:()=>Promise<{storage:number;upload:number}>;failAdopt:()=>Promise<void>;dispose:()=>Promise<void>};
export function lmsUploadContract(name:string,setup:()=>Promise<UploadFixture>){
 describe(`${name} immutable LMS upload contract`,()=>{
  let f:UploadFixture,objects:Map<string,Uint8Array>,beforePut:(()=>Promise<void>)|undefined,beforeHead:(()=>Promise<void>)|undefined;
  beforeEach(async()=>{
   f=await setup();objects=new Map();beforePut=undefined;beforeHead=undefined;
   f.env.LTI_CONFIG=JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]});f.env.USE_S3_STORAGE='false';f.env.RUNTIME='node';
   f.env.VIDEO_BUCKET={
    put:async(key:string,body:ReadableStream<Uint8Array>)=>{const chunks:Uint8Array[]=[];const reader=body.getReader();try{for(;;){const r=await reader.read();if(r.done)break;chunks.push(r.value);}}finally{reader.releaseLock();}const data=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let offset=0;for(const c of chunks){data.set(c,offset);offset+=c.length;}if(beforePut)await beforePut();objects.set(key,data);},
    head:async(key:string)=>{const data=objects.get(key);if(beforeHead)await beforeHead();return data?{size:data.length}:null;},delete:async(key:string)=>{objects.delete(key);},list:()=>Promise.resolve({objects:[],truncated:false}),
   } as unknown as R2Bucket;
   await seedSyncContext(f.execute,'course',101);
   await syncLmsResource(f.env,uploadGrant,'source',uploadManifest());
  });afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
  const data=()=>getLmsResource(f.env,uploadGrant,'source');
  const snapshot=async()=>lmsUploadSnapshot(await data(),'source',1);
  const body=(bytes=[1,2,3])=>new ReadableStream<Uint8Array>({start(c){c.enqueue(Uint8Array.from(bytes));c.close();}});
  const upload=async(s?:LmsUploadSnapshot,bytes?:number[])=>uploadLmsContent(f.env,uploadGrant,s??await snapshot(),body(bytes));
  const attempt=async(s?:LmsUploadSnapshot)=>({id:crypto.randomUUID(),grant:uploadGrant,snapshot:s??await snapshot(),fileKey:buildPendingUploadFileKey('owner',3,'.mp4')});
  const gc=async()=>{await f.execute("UPDATE external_tasks SET available_at='2000-01-01' WHERE kind='storage_cleanup'");for(const t of (await f.tasks()).filter(t=>t.kind==='storage_cleanup'))await processExternalTasks(f.env,{taskId:t.id,arm:false});};
  it('writes an immutable key, atomically adopts it and confirms one processing job',async()=>{
   const old=await snapshot();await upload(old);const current=await snapshot();expect(current.fileKey).not.toBe(old.fileKey);expect([...objects.get('media/'+current.fileKey)!]).toEqual([1,2,3]);
   await confirmLmsUpload(f.env,uploadGrant,current,'uploading');await confirmLmsUpload(f.env,uploadGrant,current,'pending');expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(1);expect((await data())?.video?.status).toBe('pending');
   await expect(upload(current)).rejects.toMatchObject({status:409});expect([...objects.get('media/'+current.fileKey)!]).toEqual([1,2,3]);
  });
  it('serializes active attempts and fences expired claims and stale abandonment',async()=>{
   const repo=await createLmsUploadRepository(f.env),first=await attempt(),second=await attempt();expect(await repo.prepare(first)).toBe(true);expect(await repo.prepare(first)).toBe(true);expect(await repo.prepare(second)).toBe(false);
   await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',contentSlot(first.snapshot)]);expect(await repo.prepare(second)).toBe(true);await repo.abandon(first);expect(await repo.adopt(first)).toBe(false);expect(await repo.adopt(second)).toBe(true);
   expect((await snapshot()).fileKey).toBe(second.fileKey);
  });
  it('serializes adoption against abandonment so cleanup cannot delete an adopted candidate',async()=>{
   const repo=await createLmsUploadRepository(f.env),a=await attempt();expect(await repo.prepare(a)).toBe(true);objects.set('media/'+a.fileKey,Uint8Array.from([1,2,3]));
   const [adopted]=await Promise.all([repo.adopt(a),repo.abandon(a)]);await gc();
   expect((await snapshot()).fileKey===a.fileKey).toBe(adopted);expect(objects.has('media/'+a.fileKey)).toBe(adopted);expect(await f.quota()).toEqual({storage:3,upload:3});
  });
  it('does not reuse an abandoned attempt or adopt a candidate already claimed for cleanup',async()=>{
   const repo=await createLmsUploadRepository(f.env),a=await attempt();expect(await repo.prepare(a)).toBe(true);await repo.abandon(a);expect(await repo.prepare(a)).toBe(false);
   const next=await attempt();expect(await repo.prepare(next)).toBe(true);await f.execute("UPDATE external_tasks SET attempts=1,locked_at=? WHERE dedupe_key=?",[new Date().toISOString(),'lms-content-stage:'+next.id]);expect(await repo.adopt(next)).toBe(false);
  });
  it.each([{bytes:[1,2]},{bytes:[1,2,3,4]}])('rejects mismatched streaming bytes %j without adopting the partial object',async ({bytes})=>{
   const original=await snapshot();await expect(upload(original,bytes)).rejects.toMatchObject({code:'UPLOAD_SIZE_MISMATCH'});expect((await snapshot()).fileKey).toBe(original.fileKey);expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(0);expect(await f.quota()).toEqual({storage:3,upload:3});
  });
  it('does not hold a database transaction during storage I/O and refuses disabled generations',async()=>{
   const original=await snapshot();beforePut=async()=>{await syncLmsResource(f.env,uploadGrant,'source',uploadManifest(2,false));};
   await expect(upload(original)).rejects.toMatchObject({status:409});expect((await data())?.video?.file).toBe(original.fileKey);expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(0);await gc();expect(objects.size).toBe(0);
  });
  it('fences teacher disconnection during storage I/O and leaves only retryable cleanup',async()=>{
   const original=await snapshot();beforePut=async()=>{await f.execute("UPDATE teaching_connections SET active=false WHERE context_id='course'");};
   await expect(upload(original)).rejects.toMatchObject({status:409});
   expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(0);expect(await f.quota()).toEqual({storage:3,upload:3});
   await gc();expect(objects.size).toBe(0);
  });
  it('does not confirm old push media after the teacher switches to a linked native course',async()=>{
   await upload();const current=await snapshot();beforeHead=async()=>{await f.execute("UPDATE teaching_connections SET resource_link_id='native-entry' WHERE context_id='course'");};
   await expect(confirmLmsUpload(f.env,uploadGrant,current,'uploading')).rejects.toMatchObject({status:409});
   expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(0);
  });
  it('rechecks generation after object HEAD without creating a stale processing job',async()=>{
   await upload();const current=await snapshot();beforeHead=async()=>{beforeHead=undefined;await syncLmsResource(f.env,uploadGrant,'source',uploadManifest(2,false));};
   await expect(confirmLmsUpload(f.env,uploadGrant,current,'uploading')).rejects.toMatchObject({status:409});expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(0);
  });
  it('keeps the current reservation when stored bytes are missing or invalid',async()=>{
   const s=await snapshot();await expect(confirmLmsUpload(f.env,uploadGrant,s,'uploading')).rejects.toMatchObject({status:409});objects.set('media/'+s.fileKey,Uint8Array.from([1]));
   await expect(confirmLmsUpload(f.env,uploadGrant,s,'uploading')).rejects.toMatchObject({status:409});expect((await data())?.video?.status).toBe('uploading');expect(await f.quota()).toEqual({storage:3,upload:3});
   expect(await (await createLmsUploadRepository(f.env)).confirm(uploadGrant,s,false)).toEqual({status:'stale'});
  });
  it('retains adopted media on a stale abandon and cleans superseded keys without refunding quota',async()=>{
   const repo=await createLmsUploadRepository(f.env),old=await snapshot();await upload(old);const first=await snapshot();await upload(first,[4,5,6]);const second=await snapshot();
   await gc();expect(objects.has('media/'+first.fileKey)).toBe(false);expect([...objects.get('media/'+second.fileKey)!]).toEqual([4,5,6]);expect(await f.quota()).toEqual({storage:3,upload:3});
   const a=await attempt(second);expect(await repo.prepare(a)).toBe(true);objects.set('media/'+a.fileKey,Uint8Array.from([7,8,9]));expect(await repo.adopt(a)).toBe(true);await repo.abandon(a);await gc();expect(objects.has('media/'+a.fileKey)).toBe(true);
  });
  it('rolls back a failed adoption and durably collects the unused candidate',async()=>{
   const original=await snapshot();await f.failAdopt();await expect(upload(original)).rejects.toThrow('adopt failure');expect((await snapshot()).fileKey).toBe(original.fileKey);expect(await f.quota()).toEqual({storage:3,upload:3});
   expect((await f.tasks()).filter(t=>t.kind==='storage_cleanup').every(t=>t.payload.bytes===0)).toBe(true);await gc();expect(objects.size).toBe(0);
  });
  it('runs the real bearer-authenticated Hono content/confirm routes on the selected backend',async()=>{
   const app=new Hono<AppEnv>();app.route('/api/lms',lmsRoutes);const headers={Authorization:'Bearer '+'f'.repeat(64),'Content-Type':'video/mp4','Content-Length':'3'};
   const response=await app.request('https://api.example/api/lms/resources/source/content?generation=1',{method:'PUT',headers,body:Uint8Array.from([1,2,3])},f.env);expect(response.status).toBe(200);
   const confirm=()=>app.request('https://api.example/api/lms/resources/source/confirm',{method:'POST',headers:{Authorization:headers.Authorization,'Content-Type':'application/json'},body:JSON.stringify({generation:1})},f.env);
   expect((await confirm()).status).toBe(200);expect((await confirm()).status).toBe(200);expect((await f.tasks()).filter(t=>t.kind==='sqs_job')).toHaveLength(1);
  });
 });
}
