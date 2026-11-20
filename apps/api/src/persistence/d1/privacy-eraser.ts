import { privacyErasurePlan, privacyOperationBarriers } from '../../application/privacy-policy';
import {ApiError} from '../../shared/errors';
import {privacyRequest,privacySubject,type PrivacyInstallation} from '../../shared/privacy';
import {operationReservationKey} from '../../shared/lti-operation-key';
import {privacyReadDefs as defs,privacyScoped as scoped} from './privacy-read-definitions';
import {prepareD1PrivacyScope,checkD1PrivacyScope} from './privacy-scope';
import type {z} from 'zod';
type EraseRequest=Extract<z.infer<typeof privacyRequest>,{action:'erase'}>;
const ids=(collection:typeof defs[keyof typeof defs])=>`SELECT ${collection.key} FROM ${collection.from} WHERE ${scoped(collection)}`;
const operationIds=(kind:'material_operations'|'tag_operations')=>`(SELECT json_group_array(id) FROM(SELECT CAST(${defs[kind].key} AS TEXT) AS id FROM ${defs[kind].from} WHERE ${scoped(defs[kind])} ORDER BY ${defs[kind].key}))`;
const sessions=`SELECT h.id FROM eligible p JOIN lti_credentials h ON h.kind='session' AND json_extract(h.payload,'$.registrationId')=p.registration AND json_extract(h.payload,'$.subjectHash')=p.subject_hash
 WHERE coalesce(json_extract(h.payload,'$.contextId'),'@orphan') IN(SELECT value FROM json_each(p.contexts))`;
/** One atomic D1 batch revokes sessions and erases all selected personal data.
 * Permanent operation barriers and metadata deletion succeed or roll back together. */
export function createD1PrivacyEraser(database:D1Database){return {async execute(installation:PrivacyInstallation,input:EraseRequest){
 const parsed=privacyRequest.safeParse(input);if(!parsed.success||parsed.data.action!=='erase')throw new ApiError(400,'VALIDATION_ERROR','Invalid privacy erase request.');input=parsed.data;
 const subject=await privacySubject(installation,input.subject);
 for(let retry=0;retry<5;retry++){
  const scope=await prepareD1PrivacyScope(database,installation,[subject],input.contexts),query=(sql:string,args:unknown[]=[])=>scope.query(subject,sql,args);
  const prepared=await database.batch<Record<string,unknown>>([scope.check(),query(`SELECT ${operationIds('material_operations')} AS material,${operationIds('tag_operations')} AS tag`)]);
  if(!checkD1PrivacyScope(prepared[0].results[0]))continue;
  const snapshot=prepared[1].results[0],keys:Array<{key:string}>=[];
  for(const {operation:kind} of privacyOperationBarriers){
   const raw=snapshot[kind];if(typeof raw!=='string')throw new Error('Invalid privacy operation snapshot');const values=JSON.parse(raw) as string[];
   for(let offset=0;offset<values.length;offset+=100)keys.push(...await Promise.all(values.slice(offset,offset+100).map(async id=>({key:await operationReservationKey(kind,id)}))));
  }
  const token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
  const statements=[scope.check(),query(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'privacy_erase',0 FROM eligible p WHERE ${operationIds('material_operations')}=? AND ${operationIds('tag_operations')}=?`,[token,snapshot.material,snapshot.tag]),
   database.prepare(`INSERT INTO lti_operation_reservations(key) SELECT json_extract(value,'$.key') FROM json_each(?) WHERE ${gate} ON CONFLICT DO NOTHING`).bind(JSON.stringify(keys),token)];
  const counts=new Map<string,number>();
  const mutate=(name:string,sql:string,args:unknown[]=[])=>{
   statements.push(query(sql,[...args,token]));counts.set(name,statements.length);statements.push(database.prepare('SELECT changes() AS count'));
  };
  for(const effect of privacyErasurePlan()) {
   switch(effect.target) {
    // Remove feedback before its session/log selectors disappear.
    case 'feedback':
     mutate(effect.target,`DELETE FROM lti_credentials WHERE kind='lti-feedback' AND (
      (json_type(payload,'$.sessionHash')='text' AND json_extract(payload,'$.sessionHash') IN(${sessions})) OR
      (json_type(payload,'$.logId') IN('integer','real','text') AND CAST(json_extract(payload,'$.logId') AS TEXT) IN(SELECT CAST(l.id AS TEXT) FROM ${defs.logs.from} WHERE ${scoped(defs.logs)}))) AND ${gate}`);break;
    case 'sessions':mutate(effect.target,`DELETE FROM lti_credentials WHERE id IN(${sessions}) AND ${gate}`);break;
    case 'recentHistory':mutate(effect.target,`DELETE FROM lti_credentials WHERE id IN(${ids(defs.recent_history)}) AND ${gate}`);break;
    case 'conversations':mutate(effect.target,`DELETE FROM chat_conversations WHERE thread_id IN(SELECT c.thread_id FROM ${defs.conversations.from} WHERE ${scoped(defs.conversations)}) AND ${gate}`);break;
    case 'logs':mutate(effect.target,`DELETE FROM chat_logs WHERE id IN(${ids(defs.logs)}) AND ${gate}`);break;
    case 'questions': {
     const fields=effect.fields;
     mutate(effect.target,`UPDATE course_questions SET title=?,body=?,lti_author_id=?,lti_instructor=?,featured=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN(${ids(defs.questions)}) AND ${gate}`,
      [fields.title,fields.body,fields.author,Number(fields.instructor),Number(fields.featured)]);break;
    }
    case 'replies': {
     const fields=effect.fields;
     mutate(effect.target,`UPDATE course_question_replies SET body=?,lti_author_id=?,lti_instructor=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN(${ids(defs.replies)}) AND ${gate}`,
      [fields.body,fields.author,Number(fields.instructor)]);break;
    }
    case 'votes':mutate(effect.target,`DELETE FROM course_question_lti_votes WHERE (question_id,lti_author_id) IN(SELECT v.question_id,v.lti_author_id FROM ${defs.votes.from} WHERE ${scoped(defs.votes)}) AND ${gate}`);break;
    case 'moderation':mutate(effect.target,`UPDATE course_qa_moderation SET lti_actor_id=? WHERE id IN(${ids(defs.moderation)}) AND ${gate}`,[effect.actor]);break;
    case 'materialOperations': case 'tagOperations': {
     const barrier=privacyOperationBarriers.find(item=>item.count===effect.target)!;
     const table={material_operations:'lti_material_operations',tag_operations:'lti_course_tag_operations'}[barrier.collection];
     mutate(effect.target,`DELETE FROM ${table} WHERE id IN(${ids(defs[barrier.collection])}) AND ${gate}`);break;
    }
    case 'reportAccesses':mutate(effect.target,`DELETE FROM lti_report_accesses WHERE id IN(${ids(defs.report_accesses)}) AND ${gate}`);break;
   }
  }
  const receipt=statements.length;
  statements.push(database.prepare('SELECT token FROM mutation_receipts WHERE token=?').bind(token),database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token));
  const result=await database.batch<Record<string,unknown>>(statements);
  if(!checkD1PrivacyScope(result[0].results[0]))continue;
  if(result[receipt].results.length)return {erased:Object.fromEntries([...counts].map(([name,index])=>[name,Number(result[index].results[0].count)]))};
 }
 throw new ApiError(409,'CONFLICT','Data changed. Restart the erasure.');
}};}
