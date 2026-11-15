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
  for(const kind of ['material','tag'] as const){
   const raw=snapshot[kind];if(typeof raw!=='string')throw new Error('Invalid privacy operation snapshot');const values=JSON.parse(raw) as string[];
   for(let offset=0;offset<values.length;offset+=100)keys.push(...await Promise.all(values.slice(offset,offset+100).map(async id=>({key:await operationReservationKey(kind,id)}))));
  }
  const token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
  const statements=[scope.check(),query(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'privacy_erase',0 FROM eligible p WHERE ${operationIds('material_operations')}=? AND ${operationIds('tag_operations')}=?`,[token,snapshot.material,snapshot.tag]),
   database.prepare(`INSERT INTO lti_operation_reservations(key) SELECT json_extract(value,'$.key') FROM json_each(?) WHERE ${gate} ON CONFLICT DO NOTHING`).bind(JSON.stringify(keys),token)];
  const counts=new Map<string,number>();
  const mutate=(name:string,sql:string)=>{
   statements.push(query(sql,[token]));counts.set(name,statements.length);statements.push(database.prepare('SELECT changes() AS count'));
  };
  // Remove feedback before its session/log selectors disappear.
  mutate('feedback',`DELETE FROM lti_credentials WHERE kind='lti-feedback' AND (
   (json_type(payload,'$.sessionHash')='text' AND json_extract(payload,'$.sessionHash') IN(${sessions})) OR
   (json_type(payload,'$.logId') IN('integer','real','text') AND CAST(json_extract(payload,'$.logId') AS TEXT) IN(SELECT CAST(l.id AS TEXT) FROM ${defs.logs.from} WHERE ${scoped(defs.logs)}))) AND ${gate}`);
  mutate('sessions',`DELETE FROM lti_credentials WHERE id IN(${sessions}) AND ${gate}`);
  mutate('recentHistory',`DELETE FROM lti_credentials WHERE id IN(${ids(defs.recent_history)}) AND ${gate}`);
  mutate('conversations',`DELETE FROM chat_conversations WHERE thread_id IN(SELECT c.thread_id FROM ${defs.conversations.from} WHERE ${scoped(defs.conversations)}) AND ${gate}`);
  mutate('logs',`DELETE FROM chat_logs WHERE id IN(${ids(defs.logs)}) AND ${gate}`);
  mutate('questions',`UPDATE course_questions SET title='[deleted]',body='[deleted]',lti_author_id='${'0'.repeat(64)}',lti_instructor=0,featured=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN(${ids(defs.questions)}) AND ${gate}`);
  mutate('replies',`UPDATE course_question_replies SET body='[deleted]',lti_author_id='${'0'.repeat(64)}',lti_instructor=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN(${ids(defs.replies)}) AND ${gate}`);
  mutate('votes',`DELETE FROM course_question_lti_votes WHERE (question_id,lti_author_id) IN(SELECT v.question_id,v.lti_author_id FROM ${defs.votes.from} WHERE ${scoped(defs.votes)}) AND ${gate}`);
  mutate('moderation',`UPDATE course_qa_moderation SET lti_actor_id=NULL WHERE id IN(${ids(defs.moderation)}) AND ${gate}`);
  mutate('materialOperations',`DELETE FROM lti_material_operations WHERE id IN(${ids(defs.material_operations)}) AND ${gate}`);
  mutate('tagOperations',`DELETE FROM lti_course_tag_operations WHERE id IN(${ids(defs.tag_operations)}) AND ${gate}`);
  mutate('reportAccesses',`DELETE FROM lti_report_accesses WHERE id IN(${ids(defs.report_accesses)}) AND ${gate}`);
  const receipt=statements.length;
  statements.push(database.prepare('SELECT token FROM mutation_receipts WHERE token=?').bind(token),database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token));
  const result=await database.batch<Record<string,unknown>>(statements);
  if(!checkD1PrivacyScope(result[0].results[0]))continue;
  if(result[receipt].results.length)return {erased:Object.fromEntries([...counts].map(([name,index])=>[name,Number(result[index].results[0].count)]))};
 }
 throw new ApiError(409,'CONFLICT','Data changed. Restart the erasure.');
}};}
