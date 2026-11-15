import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {pruneLtiAudit} from '../../../src/features/lti/audit-retention';
import {createAuditRetentionRepository} from '../../../src/persistence/factory';
import {operationReservationKey} from '../../../src/shared/lti-operation-key';
import {getLmsResource} from '../../../src/repositories/lms-resource-repository';
import type {HistoryFixture} from './course-history.contract';
import type {Bindings} from '../../../src/types/bindings';
export const auditNow=new Date('2026-12-01T00:00:00.000Z'),auditCutoff=new Date('2026-11-01T00:00:00.000Z');
export const auditConfig={toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[],auditRetentionDays:30};
export type AuditTable='lti_material_operations'|'lti_course_tag_operations'|'lti_operation_reservations'|'lti_report_accesses'|'course_qa_moderation'|'lti_course_tags'|'course_questions'|'videos';
export type AuditFixture=HistoryFixture&{rows:(table:AuditTable)=>Promise<Array<Record<string,unknown>>>;failDelete:()=>Promise<void>;seedBacklog:(count:number,createdAt:string)=>Promise<void>};
export async function insertExpiredTag(f:HistoryFixture,id=crypto.randomUUID(),at='2026-10-31T23:59:59.999Z'){
 await f.execute('INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash,created_at) VALUES(?,?,?,\'create\',?,?)',[id,f.courseId,'e'.repeat(64),'a'.repeat(64),at]);return id;
}
export function auditRetentionContract(name:string,setup:()=>Promise<AuditFixture>){
 describe(`${name} audit retention contract`,()=>{
  let f:AuditFixture;beforeEach(async()=>{f=await setup();f.env.LTI_CONFIG=JSON.stringify(auditConfig);});afterEach(async()=>{await f?.dispose();});
  it('requires opt-in and validates configuration before touching persistence',async()=>{
   expect(await pruneLtiAudit({DEPLOYMENT_EDITION:'cloud'} as Bindings,auditNow)).toMatchObject({enabled:false,backlog:false});
   for(const days of [0,-1,1.5,3651,'30'])await expect(pruneLtiAudit({LTI_CONFIG:JSON.stringify({...auditConfig,auditRetentionDays:days})} as Bindings,auditNow)).rejects.toThrow('Invalid LTI_CONFIG');
   await expect(pruneLtiAudit(f.env,new Date(NaN))).rejects.toThrow('Invalid retention clock');
  });
  it('removes only expired metadata, preserves exact-boundary/shared data, and anonymizes only LTI moderators',async()=>{
   const resource=(await getLmsResource(f.env,{id:'school',ownerUserId:'owner'},'first'))!.resource;
   const question=crypto.randomUUID();await f.execute("INSERT INTO course_questions(id,course_id,title,body,author_id) VALUES(?,?,'Shared question','Shared body','owner')",[question,f.courseId]);
   await f.execute("INSERT INTO lti_course_tags(id,course_id,name,color,revision) VALUES(?,?,'Shared vocabulary','blue',?)",[crypto.randomUUID(),f.courseId,crypto.randomUUID()]);
   for(const at of ['2026-10-31T23:59:59.999Z',auditCutoff.toISOString(),'2026-11-02T00:00:00.000Z']){
    await insertExpiredTag(f,crypto.randomUUID(),at);
    await f.execute("INSERT INTO lti_material_operations(id,resource_id,video_id,course_id,source_generation,actor_key,action,request_hash,before_revision,after_revision,created_at) VALUES(?,?,?,?,1,?,'update',?,?,?,?)",[crypto.randomUUID(),resource.id,resource.videoId,f.courseId,'e'.repeat(64),'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),at]);
    await f.execute("INSERT INTO lti_report_accesses(id,installation_id,course_id,context_id,actor_key,from_date,to_date,resource_count,scope_hash,created_at) VALUES(?,'school',?,'context',?,'2026-10-01','2026-10-02',1,?,?)",[crypto.randomUUID(),f.courseId,'e'.repeat(64),'a'.repeat(64),at]);
    await f.execute("INSERT INTO course_qa_moderation(id,course_id,question_id,lti_actor_id,action,created_at) VALUES(?,?,?,?,'feature',?)",[crypto.randomUUID(),f.courseId,question,'e'.repeat(64),at]);
   }
   await f.execute("INSERT INTO course_qa_moderation(id,course_id,question_id,actor_user_id,action,created_at) VALUES(?,?,?,'owner','unfeature','2026-10-01T00:00:00.000Z')",[crypto.randomUUID(),f.courseId,question]);
   expect(await pruneLtiAudit(f.env,auditNow)).toEqual({enabled:true,materialOperations:1,tagOperations:1,moderationActors:1,reportAccesses:1,backlog:false});
   expect(await f.rows('lti_material_operations')).toHaveLength(2);expect(await f.rows('lti_course_tag_operations')).toHaveLength(2);expect(await f.rows('lti_report_accesses')).toHaveLength(2);
   const moderators=await f.rows('course_qa_moderation');expect(moderators).toHaveLength(4);expect(moderators.filter(r=>r.lti_actor_id)).toHaveLength(2);expect(moderators.filter(r=>r.actor_user_id==='owner')).toHaveLength(1);
   expect(await f.rows('lti_course_tags')).toHaveLength(1);expect((await f.rows('course_questions'))[0].body).toBe('Shared body');expect(await f.rows('videos')).toHaveLength(2);
   expect(await pruneLtiAudit(f.env,auditNow)).toMatchObject({materialOperations:0,tagOperations:0,moderationActors:0,reportAccesses:0,backlog:false});
  });
  it('keeps permanent namespaced replay hashes after deleting legacy receipts',async()=>{
   const id=crypto.randomUUID(),resource=(await getLmsResource(f.env,{id:'school',ownerUserId:'owner'},'first'))!.resource;
   await insertExpiredTag(f,id.toUpperCase());
   await f.execute("INSERT INTO lti_material_operations(id,resource_id,course_id,source_generation,actor_key,action,request_hash,before_revision,after_revision,created_at) VALUES(?,?,?,1,?,'reindex',?,?,?,'2026-10-01T00:00:00.000Z')",[id,resource.id,f.courseId,'e'.repeat(64),'a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]);
   await pruneLtiAudit(f.env,auditNow);const keys=await f.rows('lti_operation_reservations');expect(keys).toEqual(expect.arrayContaining([{key:await operationReservationKey('tag',id)},{key:await operationReservationKey('material',id)}]));expect(keys).toHaveLength(2);
   expect(keys.every(row=>Object.keys(row).join()==='key'&&/^[a-f0-9]{64}$/.test(String(row.key)))).toBe(true);
   await pruneLtiAudit(f.env,auditNow);expect(await f.rows('lti_operation_reservations')).toHaveLength(2);
  });
  it('bounds a batch to 500 and reports remaining eligible rows',async()=>{
   await f.seedBacklog(501,'2026-10-01T00:00:00.000Z');const repo=await createAuditRetentionRepository(f.env);
   expect(await repo.pruneBatch('tag',auditCutoff)).toEqual({count:500,more:true});expect(await repo.pruneBatch('tag',auditCutoff)).toEqual({count:1,more:false});expect(await f.rows('lti_operation_reservations')).toHaveLength(501);
  });
  it('bounds maintenance to 20 passes and resumes remaining work',async()=>{
   await f.seedBacklog(10001,'2026-10-01T00:00:00.000Z');expect(await pruneLtiAudit(f.env,auditNow)).toMatchObject({tagOperations:10000,backlog:true});expect(await f.rows('lti_course_tag_operations')).toHaveLength(1);
   expect(await pruneLtiAudit(f.env,auditNow)).toMatchObject({tagOperations:1,backlog:false});expect(await f.rows('lti_operation_reservations')).toHaveLength(10001);
  },30000);
  it('rolls back newly prepared replay hashes when metadata deletion fails',async()=>{
   await insertExpiredTag(f);await f.failDelete();await expect(pruneLtiAudit(f.env,auditNow)).rejects.toThrow('audit delete failure');expect(await f.rows('lti_course_tag_operations')).toHaveLength(1);expect(await f.rows('lti_operation_reservations')).toHaveLength(0);
  });
  it('does not double-count concurrent retention workers',async()=>{
   await f.seedBacklog(64,'2026-10-01T00:00:00.000Z');const repo=await createAuditRetentionRepository(f.env),results=await Promise.all([repo.pruneBatch('tag',auditCutoff),repo.pruneBatch('tag',auditCutoff)]);
   expect(results.reduce((sum,r)=>sum+r.count,0)).toBe(64);expect(await f.rows('lti_course_tag_operations')).toHaveLength(0);expect(await f.rows('lti_operation_reservations')).toHaveLength(64);
  });
 });
}
