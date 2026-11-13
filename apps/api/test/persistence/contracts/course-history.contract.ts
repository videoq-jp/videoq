import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {appendCourseHistory,readCourseHistory,courseHistoryId} from '../../../src/features/lti/history';
import {readCredential} from '../../../src/features/lti/store';
import {seedSyncOwner} from './lms-resource-sync.contract';
import {syncLmsResource} from '../../../src/repositories/lms-resource-repository';
import {resourceManifestSchema} from '../../../src/features/lms/resource';
import type {Bindings} from '../../../src/types/bindings';
import type {CourseHistoryScope} from '../../../src/persistence/contracts/course-history-repository';
export type HistoryFixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;courseId:number;videoIds:number[];dispose:()=>Promise<void>};
export async function seedHistory(env:Bindings,execute:HistoryFixture['execute']){
 await seedSyncOwner(execute);
 const resources=[];
 for(const id of ['first','second'])resources.push(await syncLmsResource(env,{id:'school',ownerUserId:'owner'},id,resourceManifestSchema.parse({generation:1,contextId:'context',resourceLinkId:id,enabled:true,title:id,file:{filename:'video.mp4',contentType:'video/mp4',size:100,contentHash:'a'.repeat(64)}})));
 return {courseId:resources[0].courseId!,videoIds:resources.map(r=>r.videoId!)};
}
export const historyAnswer=(videoId:number)=>({segments:[{text:'Saved answer',sourceIds:[1]}],sources:[{id:1,video_id:videoId,title:'Lesson',start_time:'00:00:00',end_time:'00:00:10'}]});
export function courseHistoryContract(name:string,setup:()=>Promise<HistoryFixture>){
 describe(`${name} course history contract`,()=>{
  let f:HistoryFixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
  const scope=():CourseHistoryScope=>({registrationId:'db:school',subjectHash:'d'.repeat(64),courseId:f.courseId,contextId:'context'});
  const log=async(id:number,answer:unknown=historyAnswer(f.videoIds[0]),owner='owner')=>f.execute("INSERT INTO chat_logs(id,user_id,course_id,question,response,is_shared_origin,created_at,retrieved_contexts) VALUES(?,?,?,'Question',?,false,?,'[]')",[id,owner,f.courseId,JSON.stringify(answer),new Date().toISOString()]);
  const append=(id:number,allowed:number[]|undefined=f.videoIds)=>appendCourseHistory(f.env,scope(),`question-${id}`,id,allowed);
  const read=(allowed=f.videoIds)=>readCourseHistory(f.env,scope(),'owner',allowed);
  it('atomically appends concurrent completed turns and retains attribution',async()=>{
   await Promise.all(Array.from({length:8},(_,i)=>log(i+1)));await Promise.all(Array.from({length:8},(_,i)=>append(i+1)));
   const rows=await read();expect(rows).toHaveLength(8);expect(new Set(rows.map(r=>r.logId))).toEqual(new Set([1,2,3,4,5,6,7,8]));
   expect(await readCredential(f.env,await courseHistoryId(scope()),'lti-history')).toMatchObject({registrationId:'db:school',subjectHash:scope().subjectHash,courseId:f.courseId,contextId:'context',scopeVideoIds:f.videoIds});
  });
  it('isolates learners, schools, courses, owners and the whole saved scope',async()=>{
   await log(1);await append(1);
   for(const other of [{...scope(),registrationId:'db:other'},{...scope(),subjectHash:'e'.repeat(64)},{...scope(),courseId:f.courseId+999}])expect(await readCourseHistory(f.env,other,'owner',f.videoIds)).toEqual([]);
   expect(await readCourseHistory(f.env,scope(),'other',f.videoIds)).toEqual([]);expect(await read([f.videoIds[0]])).toEqual([]);
   expect(await read([...f.videoIds,999])).toHaveLength(1);
  });
  it('hydrates only valid owned answers whose entire source set remains readable',async()=>{
   await log(1);await log(2,{invalid:true});await log(3,historyAnswer(999));await log(4,historyAnswer(f.videoIds[0]),'other');
   for(const id of [1,2,3,4])await append(id);
   expect((await read()).map(r=>r.logId)).toEqual([1]);
   await f.execute("UPDATE chat_logs SET feedback='good' WHERE id=1");expect((await read())[0].feedback).toBe('good');
   await f.execute("UPDATE chat_logs SET feedback='bad' WHERE id=1");expect((await read())[0].feedback).toBe('bad');
  });
  it('drops previous context on a scope reduction and starts fresh after expiry',async()=>{
   await log(1);await append(1);await log(2);await append(2,[f.videoIds[0]]);expect((await read([f.videoIds[0]])).map(r=>r.logId)).toEqual([2]);
   await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',await courseHistoryId(scope())]);expect(await read()).toEqual([]);
   await log(3);await append(3);expect((await read()).map(r=>r.logId)).toEqual([3]);
  });
  it('derives omitted scopes from current course membership',async()=>{
   await log(1);await appendCourseHistory(f.env,scope(),'question',1,undefined);
   expect(await readCredential(f.env,await courseHistoryId(scope()),'lti-history')).toMatchObject({scopeVideoIds:f.videoIds});
   await f.execute('DELETE FROM video_course_members WHERE course_id=? AND video_id=?',[f.courseId,f.videoIds[1]]);
   await log(2);await appendCourseHistory(f.env,scope(),'second',2,undefined);expect((await read([f.videoIds[0]])).map(r=>r.logId)).toEqual([2]);
  });
  it('keeps the last 50 turns in append order',async()=>{
   for(let id=1;id<=55;id++){await log(id);await append(id);}
   expect((await read()).map(r=>r.logId)).toEqual(Array.from({length:50},(_,i)=>i+6));
  });
  it('refuses writes and reads after session revocation without replacing saved history',async()=>{
   const s=scope(),proof={sessionHash:'a'.repeat(64),registrationId:s.registrationId,subjectHash:s.subjectHash},secured={...s,sessionProof:proof};
   await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[proof.sessionHash,'session',JSON.stringify(s),new Date(Date.now()+60_000).toISOString()]);
   await log(1);await appendCourseHistory(f.env,secured,'first',1,f.videoIds);expect(await readCourseHistory(f.env,secured,'owner',f.videoIds)).toHaveLength(1);
   await f.execute('DELETE FROM lti_credentials WHERE id=?',[proof.sessionHash]);await log(2);
   await expect(appendCourseHistory(f.env,secured,'late',2,f.videoIds)).rejects.toMatchObject({status:403});
   await expect(readCourseHistory(f.env,secured,'owner',f.videoIds)).rejects.toMatchObject({status:403});
   expect((await read()).map(r=>r.logId)).toEqual([1]);
  });
  it('rejects a proof for a different subject',async()=>{
   const secured={...scope(),sessionProof:{sessionHash:'a'.repeat(64),registrationId:'db:school',subjectHash:'e'.repeat(64)}};
   await log(1);await expect(appendCourseHistory(f.env,secured,'forged',1,f.videoIds)).rejects.toMatchObject({status:403});expect(await read()).toEqual([]);
  });
  it('does not overwrite an unrelated credential sharing the history key',async()=>{
   const id=await courseHistoryId(scope());await f.execute('INSERT INTO lti_credentials(id,kind,payload,expires_at) VALUES(?,?,?,?)',[id,'login','{}',new Date(Date.now()+60_000).toISOString()]);
   await log(1);await expect(append(1)).rejects.toMatchObject({status:403});expect(await readCredential(f.env,id,'login')).toEqual({});
  });
  it('preserves integral JSON real values from migrated history without treating booleans as IDs',async()=>{
   await log(1);await append(1);
   const payload=await readCredential(f.env,await courseHistoryId(scope()),'lti-history');
   const raw=JSON.stringify(payload).replace('"scopeVideoIds":['+f.videoIds.join(',')+']','"scopeVideoIds":['+f.videoIds.map(id=>`${id}.0`).join(',')+']').replace('"logId":1','"logId":1.0');
   await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[raw,await courseHistoryId(scope())]);
   expect((await read()).map(r=>r.logId)).toEqual([1]);await log(2);await append(2);expect((await read()).map(r=>r.logId)).toEqual([1,2]);
  });
  it.each([true,'invalid',{invalid:true}])('safely rejects a malformed turns value %j and starts fresh on append',async turns=>{
   await log(1);await append(1);
   await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[JSON.stringify({scopeVideoIds:f.videoIds,turns}),await courseHistoryId(scope())]);
   expect(await read()).toEqual([]);await log(2);await append(2);expect((await read()).map(r=>r.logId)).toEqual([2]);
  });
  it('retains JSON types in malformed turn arrays without coercing them into valid records',async()=>{
   await log(1);await append(1);
   await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[JSON.stringify({scopeVideoIds:f.videoIds,turns:[true,'text',null,1]}),await courseHistoryId(scope())]);
   expect(await read()).toEqual([]);await log(2);await append(2);expect(await read()).toEqual([]);
   expect(await readCredential(f.env,await courseHistoryId(scope()),'lti-history')).toMatchObject({turns:[true,'text',null,1,{logId:2}]});
  });
  it('drops malformed boolean scopes on append instead of treating true as video 1',async()=>{
   await log(1);await append(1);await f.execute('UPDATE lti_credentials SET payload=? WHERE id=?',[JSON.stringify({scopeVideoIds:[true],turns:[{id:'b'.repeat(32),logId:1,question:'old'}]}),await courseHistoryId(scope())]);
   expect(await read()).toEqual([]);await log(2);await append(2);expect((await read()).map(r=>r.logId)).toEqual([2]);
  });
 });
}
