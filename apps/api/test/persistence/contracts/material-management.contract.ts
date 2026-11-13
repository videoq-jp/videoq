import {seedSyncContext} from './lms-resource-sync.contract';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {manageLtiMaterial,materialManagementInput,type ManagedMaterialScope} from '../../../src/features/lti/material-management';
import type {HistoryFixture} from './course-history.contract';
export const materialSrt='1\n00:00:00,000 --> 00:00:01,000\nOriginal\n';
export type MaterialFixture=HistoryFixture&{tasks:()=>Promise<Array<{id:number;payload:{message:unknown}}>>;count:(table:'lti_material_operations'|'lti_operation_reservations'|'mutation_receipts')=>Promise<number>;failReceipt:()=>Promise<void>};
export const materialScope=(f:HistoryFixture):ManagedMaterialScope=>({installationId:'school',ownerUserId:'owner',contextId:'context',courseId:f.courseId,resourceLinkId:'first',videoId:f.videoIds[0],generation:1,actorKey:'e'.repeat(64)});
export async function seedMaterial(f:HistoryFixture){await f.execute("UPDATE videos SET status='completed',description='',transcript=? WHERE id=?",[materialSrt,f.videoIds[0]]);}
export function materialManagementContract(name:string,setup:()=>Promise<MaterialFixture>){
 describe(`${name} teaching material management contract`,()=>{
  let f:MaterialFixture,scope:ManagedMaterialScope;beforeEach(async()=>{f=await setup();scope=materialScope(f);await seedMaterial(f);});afterEach(async()=>{await f?.dispose();});
  const run=(input:unknown,principal=scope)=>manageLtiMaterial(f.env,principal,materialManagementInput.parse(input));
  const get=(principal=scope)=>run({action:'get',videoId:scope.videoId},principal);
  const update=async(fields:{description?:string;transcript?:string},revision?:string,id=crypto.randomUUID(),principal=scope)=>run({action:'update',fields,revision:revision??(await get(principal)).material.revision,operationId:id,videoId:scope.videoId},principal);
  const operation=async(action:'reindex'|'retry',revision?:string)=>run({action,videoId:scope.videoId,operationId:crypto.randomUUID(),revision:revision??(await get()).material.revision});
  it('projects bounded teaching data and leaves reads without audit writes',async()=>{
   const result=await get();expect(result.material).toMatchObject({videoId:scope.videoId,title:'first',transcript:materialSrt,status:'completed',canEdit:true,canReindex:true,canRetry:false,jobState:'completed'});
   expect(JSON.stringify(result.material)).not.toMatch(/file|owner|actorKey|installationId|resourceId|token/);expect(await f.count('lti_material_operations')).toBe(0);
  });
  it('changes description without reprocessing and keeps canonical title/media untouched',async()=>{
   const result=await update({description:'Teaching notes'});expect(result.material).toMatchObject({description:'Teaching notes',title:'first',transcript:materialSrt,status:'completed'});expect(result.externalTaskId).toBeNull();expect(await f.tasks()).toHaveLength(0);
  });
  it('queues transcript indexing once and handles unchanged and explicitly cleared transcripts',async()=>{
   expect((await update({transcript:materialSrt})).externalTaskId).toBeNull();
   const result=await update({transcript:materialSrt.replace('Original','Edited')});expect(result.material).toMatchObject({status:'indexing',canEdit:false});expect((await f.tasks())[0].payload.message).toMatchObject({type:'index_video_transcript',payload:{video_id:scope.videoId}});
   await f.execute("UPDATE videos SET status='completed' WHERE id=?",[scope.videoId]);await update({transcript:''});expect((await f.tasks())[1].payload.message).toMatchObject({payload:{video_id:scope.videoId,allow_empty:true}});
  });
  it('preserves the winning edit after concurrent teachers use the same revision',async()=>{
   const revision=(await get()).material.revision,results=await Promise.allSettled([update({description:'First'},revision),update({description:'Second'},revision)]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:409}});expect(await f.count('lti_material_operations')).toBe(1);
  });
  it('replays matching operations without duplicate jobs and rejects actor/payload changes',async()=>{
   const id=crypto.randomUUID(),revision=(await get()).material.revision,fields={transcript:materialSrt.replace('Original','Edited')};
   const first=await update(fields,revision,id),again=await update(fields,revision,id);expect(again).toMatchObject({reused:true,externalTaskId:first.externalTaskId});expect(await f.tasks()).toHaveLength(1);
   await expect(update(fields,revision,id,{...scope,actorKey:'a'.repeat(64)})).rejects.toMatchObject({status:409});await expect(update({description:'Forged'},revision,id)).rejects.toMatchObject({status:409});
  });
  it('rejects invalid SRT and oversized multibyte descriptions before mutation',async()=>{
   await expect(update({transcript:'not srt'})).rejects.toMatchObject({status:400});await expect(update({description:'あ'.repeat(15000)})).rejects.toMatchObject({status:413});expect(await f.count('lti_material_operations')).toBe(0);expect(await f.tasks()).toHaveLength(0);
  });
  it.each(['generation','context','membership','owner'])('refuses an invalid current %s scope',async field=>{
   const revision=(await get()).material.revision;
   if(field==='generation')await f.execute('UPDATE lms_resources SET generation=2 WHERE video_id=?',[scope.videoId]);
   if(field==='membership')await f.execute('DELETE FROM video_course_members WHERE video_id=?',[scope.videoId]);
   const principal=field==='context'?{...scope,contextId:'other'}:field==='owner'?{...scope,ownerUserId:'other'}:scope;
   await expect(update({description:'Denied'},revision,crypto.randomUUID(),principal)).rejects.toMatchObject({status:{generation:409,context:403,membership:409,owner:403}[field]});expect(await f.count('lti_material_operations')).toBe(0);
  });
  it('keeps teacher authority separate from installer state and refuses a revoked context even with another active connection',async()=>{
   await f.execute("UPDATE users SET is_active=false,banned=true WHERE id='installer'");expect((await get()).material.videoId).toBe(scope.videoId);
   await seedSyncContext(f.execute,'other-active',101);await f.execute("UPDATE teaching_connections SET active=false WHERE context_id='context'");
   await expect(get()).rejects.toMatchObject({status:403});expect(await f.count('lti_material_operations')).toBe(0);
  });
  it('refuses cross-course shared media without disclosing other-course identifiers',async()=>{
   const course=scope.courseId+1000,at=new Date().toISOString();
   await f.execute("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(?,'Other private course','',?,?,'other',1)",[course,at,at]);
   await f.execute('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(?,?,?,1)',[course,scope.videoId,at]);
   await expect(get()).rejects.toMatchObject({status:409});
  });
  it('retries failed transcription with its immutable original job identity',async()=>{
   const message={type:'transcribe_video',job_id:crypto.randomUUID(),payload:{video_id:scope.videoId}};
   await f.execute("UPDATE videos SET status='error' WHERE id=?",[scope.videoId]);await f.execute("INSERT INTO external_tasks(kind,payload,dedupe_key,completed_at) VALUES('sqs_job',?,'original',?)",[JSON.stringify({message}),new Date().toISOString()]);
   expect((await get()).material.canRetry).toBe(true);expect((await operation('retry')).material.status).toBe('pending');expect((await f.tasks())[1].payload.message).toEqual(message);
  });
  it('does not enqueue transcription that its completed worker receipt would ignore',async()=>{
   const message={type:'transcribe_video',job_id:crypto.randomUUID(),payload:{video_id:scope.videoId}};
   await f.execute("UPDATE videos SET status='error' WHERE id=?",[scope.videoId]);await f.execute("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',?,'original')",[JSON.stringify({message})]);
   await f.execute("INSERT INTO job_executions(job_id,job_type,payload_sha256,status) VALUES(?,'transcribe_video',?,'completed')",[message.job_id,'a'.repeat(64)]);
   expect((await get()).material.canRetry).toBe(false);await expect(operation('retry')).rejects.toMatchObject({status:409});expect(await f.tasks()).toHaveLength(1);
  });
  it('reindexes completed content and retries stalled indexing with a fresh job',async()=>{
   expect((await operation('reindex')).material.status).toBe('indexing');expect((await operation('retry')).material.status).toBe('indexing');expect(await f.tasks()).toHaveLength(2);
  });
  it('rolls back teaching text, outbox and replay barrier if durable receipt persistence fails',async()=>{
   await f.failReceipt();let failed=false;try{await update({transcript:materialSrt.replace('Original','Edited')});}catch(error){failed=true;expect(error).toBeInstanceOf(Error);const e=error as Error;expect(e.message+' '+(e.cause instanceof Error?e.cause.message:'')).toContain('receipt failure');}expect(failed).toBe(true);expect((await get()).material).toMatchObject({transcript:materialSrt,status:'completed'});expect(await f.tasks()).toHaveLength(0);expect(await f.count('lti_operation_reservations')).toBe(0);expect(await f.count('mutation_receipts')).toBe(0);
  });
  it('refuses a retired operation without reapplying text changes',async()=>{
   const id=crypto.randomUUID(),revision=(await get()).material.revision;await update({description:'Once'},revision,id);await f.execute('DELETE FROM lti_material_operations WHERE id=?',[id]);
   await expect(update({description:'Once'},revision,id)).rejects.toMatchObject({status:409});await expect(update({description:'Once'},revision,id.toUpperCase())).rejects.toMatchObject({status:409});
  });
 });
}
