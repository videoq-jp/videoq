import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {courseReport} from '../../../src/features/lti/course-reports';
import {digest} from '../../../src/features/lti/store';
import {ltiSubjectKey} from '../../../src/features/lti/identity';
import type {CourseReportScope} from '../../../src/persistence/contracts/course-report-repository';
import type {HistoryFixture} from './course-history.contract';
export type ReportFixture=HistoryFixture&{audits:()=>Promise<Array<{actorKey:string;resourceCount:number;scopeHash:string}>>;failAudit:()=>Promise<void>};
export const reportPeriod={action:'summary' as const,from:'2026-11-01',to:'2026-11-02'};
export async function seedReport(f:HistoryFixture):Promise<CourseReportScope>{
 await f.execute("UPDATE videos SET status='completed'");
 const sessionProof={sessionHash:'b'.repeat(64),registrationId:'db:school',subjectHash:'d'.repeat(64)};
 const scope={installationId:'school',ownerUserId:'owner',contextId:'context',courseId:f.courseId,sessionProof,readable:f.videoIds.map((videoId,i)=>({videoId,generation:1,resourceLinkId:['first','second'][i]}))};
 await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[sessionProof.sessionHash,'session',JSON.stringify({...sessionProof,contextId:scope.contextId,courseId:scope.courseId}),new Date(Date.now()+3600_000).toISOString()]);
 return scope;
}
export function courseReportContract(name:string,setup:()=>Promise<ReportFixture>){
 describe(`${name} aggregate course report contract`,()=>{
  let f:ReportFixture,scope:CourseReportScope,nextId:number;
  beforeEach(async()=>{f=await setup();scope=await seedReport(f);nextId=0;});afterEach(async()=>{await f?.dispose();});
  const report=(override:Partial<CourseReportScope>={})=>courseReport(f.env,{...scope,...override},reportPeriod);
  const log=async(resources:unknown=f.videoIds,at='2026-11-01T12:00:00Z',feedback:string|null=null,response:unknown={sources:[]},registration:string|null='db:school',context:string|null='context',owner='owner')=>{
   const id=++nextId;
   await f.execute('INSERT INTO chat_logs(id,user_id,course_id,question,response,is_shared_origin,created_at,retrieved_contexts,feedback) VALUES(?,?,?,\'PRIVATE question\',?,true,?,\'["PRIVATE context"]\',?)',[id,owner,f.courseId,JSON.stringify(response),at,feedback]);
   await f.execute('INSERT INTO lti_chat_log_subjects(chat_log_id,subject_key,resource_video_ids,registration_id,context_id) VALUES(?,?,?,?,?)',[id,'e'.repeat(64),JSON.stringify(resources),registration,context]);return id;
  };
  it('returns only UTC daily aggregates and writes an identifier-only scope receipt',async()=>{
   await log([f.videoIds[0]],'2026-11-01T00:00:00Z','good');await log([f.videoIds[1]],'2026-11-03T08:59:59.999+09:00','bad');await log();
   await log(undefined,'2026-10-31T23:59:59.999Z');await log(undefined,'2026-11-03T00:00:00Z');
   const result=await report();expect(result).toEqual({period:{from:reportPeriod.from,to:reportPeriod.to,timezone:'UTC'},totals:{questions:3,good:1,bad:1,none:1},days:[{date:'2026-11-01',questions:2,good:1,bad:0,none:1},{date:'2026-11-02',questions:1,good:0,bad:1,none:0}],coverage:'verified-moodle-resource-scope'});
   expect(JSON.stringify(result)).not.toMatch(/PRIVATE|owner|subject|actor|resourceVideoIds|registrationId|contextId|logId/);
   expect(await f.audits()).toEqual([{actorKey:await ltiSubjectKey(scope.sessionProof),resourceCount:2,scopeHash:await digest(JSON.stringify(f.videoIds))}]);
  });
  it('excludes missing provenance, foreign registrations/contexts, owners and empty original scopes',async()=>{
   await log();await log(undefined,undefined,null,undefined,null,null);await log(undefined,undefined,null,undefined,'db:other');await log(undefined,undefined,null,undefined,undefined,'other');await log(undefined,undefined,null,undefined,undefined,undefined,'other');await log([]);
   expect((await report()).totals.questions).toBe(1);
  });
  it('requires the whole original scope and every citation to remain readable',async()=>{
   await log([f.videoIds[0]]);await log([f.videoIds[1]]);await log();await log([f.videoIds[0]],undefined,null,{sources:[{video_id:f.videoIds[1]}]});
   expect((await report({readable:scope.readable.slice(0,1)})).totals.questions).toBe(1);expect((await f.audits())[0].resourceCount).toBe(1);
   expect((await report({readable:[]})).totals.questions).toBe(0);
  });
  it.each(['membership','disabled','generation','processing'])('rechecks current %s',async change=>{
   await log([f.videoIds[0]]);await log([f.videoIds[1]]);
   if(change==='membership')await f.execute('DELETE FROM video_course_members WHERE course_id=? AND video_id=?',[f.courseId,f.videoIds[0]]);
   if(change==='disabled')await f.execute('UPDATE lms_resources SET enabled=false WHERE video_id=?',[f.videoIds[0]]);
   if(change==='generation')await f.execute('UPDATE lms_resources SET generation=2 WHERE video_id=?',[f.videoIds[0]]);
   if(change==='processing')await f.execute("UPDATE videos SET status='indexing' WHERE id=?",[f.videoIds[0]]);
   expect((await report()).totals.questions).toBe(1);expect((await f.audits())[0].resourceCount).toBe(1);
  });
  it.each(['expired','contextId','courseId','registrationId','subjectHash'])('rejects a changed session %s before auditing',async field=>{
   if(field==='expired')await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',scope.sessionProof.sessionHash]);
   else await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[JSON.stringify({...scope.sessionProof,contextId:scope.contextId,courseId:scope.courseId,[field]:field==='courseId'?999:'other'}),scope.sessionProof.sessionHash]);
   await expect(report()).rejects.toMatchObject({status:403});expect(await f.audits()).toEqual([]);
  });
  it.each(['connection','owner','course'])('refuses an unavailable %s before auditing',async field=>{
   if(field==='connection')await f.execute("UPDATE lms_installations SET active=false WHERE id='school'");
   if(field==='owner')await f.execute("UPDATE users SET is_active=false WHERE id='owner'");
   if(field==='course')await f.execute('UPDATE video_courses SET managed_by_lms=false WHERE id=?',[f.courseId]);
   await expect(report()).rejects.toMatchObject({status:403});expect(await f.audits()).toEqual([]);
  });
  it('fails closed when the audit cannot be inserted',async()=>{
   await log();await f.failAudit();await expect(report()).rejects.toThrow('audit failure');expect(await f.audits()).toEqual([]);
  });
  it('accepts integral JSON real IDs migrated from PostgreSQL without weakening type checks',async()=>{
   const id=await log([f.videoIds[0]]);
   await f.execute('UPDATE lti_chat_log_subjects SET resource_video_ids=? WHERE chat_log_id=?',[`[${f.videoIds[0]}.0]`,id]);
   await f.execute('UPDATE chat_logs SET response=? WHERE id=?',[`{"sources":[{"video_id":${f.videoIds[0]}.0}]}`,id]);
   expect((await report()).totals.questions).toBe(1);
  });
  it('deduplicates current IDs and never counts malformed or coerced JSON scopes/sources',async()=>{
   await log([f.videoIds[0]],undefined,null,{sources:[{video_id:f.videoIds[0]}]});
   for(const original of [[true],[String(f.videoIds[0])],[null]])await log(original);
   for(const source of [true,'string',{},null,{video_id:true},{video_id:String(f.videoIds[0])}])await log([f.videoIds[0]],undefined,null,{sources:[source]});
   for(const response of [null,true,{}, {sources:true}])await log([f.videoIds[0]],undefined,null,response);
   expect((await report({readable:[...scope.readable,...scope.readable]})).totals.questions).toBe(1);expect((await f.audits())[0].resourceCount).toBe(2);
  });
 });
}
