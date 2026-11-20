import { privacyIdentityPrefixes } from '../../application/subject-identity';
import { privacyCourseContext, privacyRecentContext, privacyReportContext, privacyRecordAllowed } from '../../application/privacy-policy';
import { privacyStringLogic } from '../privacy-policy-sql';
import { privacyCursorFailure, privacyRecordCursor, privacyErasurePlan, privacyOperationBarriers } from '../../application/privacy-policy';
import { PRIVACY_CONTEXT_PAGE_SIZE } from '../../application/privacy';
import { privacyContextCollections, privacyContextPage, privacyExportPage, PRIVACY_EXPORT_CHUNK_CHARACTERS } from "../../application/privacy";
import {reservationExpression} from './operation-reservations';
import type pg from 'pg';
import {z} from 'zod';
import {ApiError} from '../../shared/errors';
import {ORPHAN_CONTEXT,privacyCollections,privacyRequest,type PrivacyInstallation,type PrivacySubject as Subject} from '../../shared/privacy';
export {ORPHAN_CONTEXT,privacyCollections,privacyRequest,privacySubject,type PrivacyInstallation} from '../../shared/privacy';
// All identifiers/expressions below are fixed application SQL. Inputs are parameters.
const parameters=`WITH params AS(SELECT $1::text owner,$2::text subject,$3::text qa_prefix,$4::text history_prefix,
  $5::text registration,$6::text subject_hash,$7::text installation,$8::text[] contexts)`;
const contextFor=(course:string)=>privacyCourseContext(`(SELECT m.context_id FROM lms_courses m
  WHERE m.installation_id=p.installation AND m.course_id=${course} ORDER BY m.id LIMIT 1)`,
  `(SELECT t.context_id FROM teaching_connections t WHERE t.provider='moodle' AND t.installation_id=p.installation
    AND t.course_id=${course} ORDER BY t.context_id COLLATE "C" LIMIT 1)`,privacyStringLogic);
const reportContext=(alias:string)=>privacyReportContext(`EXISTS(SELECT 1 FROM lms_courses rc WHERE rc.installation_id=p.installation
  AND rc.course_id=${alias}.course_id AND rc.context_id=${alias}.context_id)`,`EXISTS(SELECT 1 FROM teaching_connections tc
  WHERE tc.provider='moodle' AND tc.installation_id=p.installation AND tc.course_id=${alias}.course_id
    AND tc.context_id=${alias}.context_id)`,`${alias}.context_id`,privacyStringLogic);
const author=(course:string)=>`encode(sha256(convert_to(p.qa_prefix||${course}::text||']','UTF8')),'hex')`;
type Collection = {from:string;where:string;key:string;cast:'bigint'|'uuid'|'text';context:string;data:string};
const conversationFrom=`params p JOIN chat_conversations c ON true
  JOIN lti_conversation_scopes s ON s.thread_id=c.thread_id AND s.subject_key=p.subject`;
const logFrom=`params p JOIN chat_logs l ON true JOIN lti_chat_log_subjects s ON s.chat_log_id=l.id AND s.subject_key=p.subject`;
const defs:Record<typeof privacyCollections[number],Collection>={
  logs:{from:logFrom,where:'true',key:'l.id',cast:'bigint',context:contextFor('l.course_id'),
    data:`jsonb_build_object('question',l.question,'answer',l.response,'feedback',l.feedback,'retrievedContexts',l.retrieved_contexts,'createdAt',l.created_at,'resourceVideoIds',s.resource_video_ids,'registrationId',s.registration_id,'contextId',s.context_id,'questionAuthor',s.classroom_author)`},
  evaluations:{from:logFrom+' JOIN chat_log_evaluations e ON e.chat_log_id=l.id',where:'true',key:'e.id',cast:'bigint',context:contextFor('l.course_id'),
    data:`jsonb_build_object('status',e.status,'faithfulness',e.faithfulness,'answerRelevancy',e.answer_relevancy,'contextPrecision',e.context_precision,'createdAt',e.created_at,'evaluatedAt',e.evaluated_at)`},
  conversations:{from:conversationFrom,where:'true',key:"'thread:'||c.thread_id",cast:'text',context:contextFor('c.course_id'),
    data:`jsonb_build_object('conversationId',c.conversation_id,'title',c.title,'createdAt',c.created_at,'updatedAt',c.updated_at,'expiresAt',c.expires_at,'resourceVideoIds',s.resource_video_ids)`},
  turns:{from:conversationFrom+' JOIN chat_conversation_turns t ON t.thread_id=c.thread_id',where:'true',key:'t.id',cast:'bigint',context:contextFor('c.course_id'),
    data:`jsonb_build_object('conversationId',c.conversation_id,'question',t.question,'answer',t.response,'createdAt',t.created_at)`},
  questions:{from:'params p JOIN video_courses c ON true JOIN course_questions q ON q.course_id=c.id',where:`q.lti_author_id=${author('c.id')}`,key:'q.id',cast:'uuid',context:contextFor('c.id'),
    data:`jsonb_build_object('questionId',q.id,'title',q.title,'body',q.body,'featured',q.featured,'sourceVideoId',q.source_video_id,'createdAt',q.created_at,'updatedAt',q.updated_at)`},
  replies:{from:'params p JOIN video_courses c ON true JOIN course_questions q ON q.course_id=c.id JOIN course_question_replies r ON r.question_id=q.id',where:`r.lti_author_id=${author('c.id')}`,key:'r.id',cast:'uuid',context:contextFor('c.id'),
    data:`jsonb_build_object('questionId',q.id,'replyId',r.id,'body',r.body,'createdAt',r.created_at,'updatedAt',r.updated_at)`},
  votes:{from:'params p JOIN video_courses c ON true JOIN course_questions q ON q.course_id=c.id JOIN course_question_lti_votes v ON v.question_id=q.id',where:`v.lti_author_id=${author('c.id')}`,key:'v.question_id',cast:'uuid',context:contextFor('c.id'),
    data:`jsonb_build_object('questionId',q.id,'createdAt',v.created_at)`},
  moderation:{from:'params p JOIN video_courses c ON true JOIN course_qa_moderation m ON m.course_id=c.id',where:`m.lti_actor_id=${author('c.id')}`,key:'m.id',cast:'uuid',context:contextFor('c.id'),
    data:`jsonb_build_object('questionId',m.question_id,'replyId',m.reply_id,'action',m.action,'createdAt',m.created_at)`},
  material_operations:{from:'params p JOIN video_courses c ON true JOIN lti_material_operations m ON m.course_id=c.id',where:'m.actor_key=p.subject',key:'m.id',cast:'uuid',context:contextFor('c.id'),
    data:`jsonb_build_object('operationId',m.id,'action',m.action,'sourceGeneration',m.source_generation,'requestHash',m.request_hash,'beforeRevision',m.before_revision,'afterRevision',m.after_revision,'createdAt',m.created_at)`},
  tag_operations:{from:'params p JOIN video_courses c ON true JOIN lti_course_tag_operations m ON m.course_id=c.id',where:'m.actor_key=p.subject',key:'m.id',cast:'uuid',context:contextFor('c.id'),
    data:`jsonb_build_object('operationId',m.id,'action',m.action,'requestHash',m.request_hash,'createdAt',m.created_at)`},
  report_accesses:{from:'params p JOIN video_courses c ON true JOIN lti_report_accesses m ON m.course_id=c.id',
    where:'m.actor_key=p.subject AND m.installation_id=p.installation',key:'m.id',cast:'uuid',context:reportContext('m'),
    data:`jsonb_build_object('accessId',m.id,'from',m.from_date,'to',m.to_date,'resourceCount',m.resource_count,'scopeHash',m.scope_hash,'createdAt',m.created_at)`},
  recent_history:{from:'params p JOIN lti_credentials h ON h.kind=\'lti-history\'',where:`h.kind='lti-history' AND h.payload->>'registrationId'=p.registration AND h.payload->>'subjectHash'=p.subject_hash`,key:'h.id',cast:'text',
    context:privacyRecentContext("h.payload->>'contextId'",contextFor("CASE WHEN h.payload->>'courseId' ~ '^[1-9][0-9]{0,17}$' THEN (h.payload->>'courseId')::bigint END"),privacyStringLogic),
    data:`jsonb_build_object('turns',h.payload->'turns','expiresAt',h.expires_at)`},
  checkpoints:{from:conversationFrom+' JOIN chat_memory.checkpoints k ON k.thread_id=c.thread_id',where:'true',key:`jsonb_build_array(k.thread_id,k.checkpoint_ns,k.checkpoint_id)::text`,cast:'text',context:contextFor('c.course_id'),
    data:`jsonb_build_object('conversationId',c.conversation_id,'namespace',k.checkpoint_ns,'checkpointId',k.checkpoint_id,'parentCheckpointId',k.parent_checkpoint_id,'checkpoint',k.checkpoint,'metadata',k.metadata)`},
  checkpoint_blobs:{from:conversationFrom+' JOIN chat_memory.checkpoint_blobs k ON k.thread_id=c.thread_id',where:'true',key:`jsonb_build_array(k.thread_id,k.checkpoint_ns,k.channel,k.version)::text`,cast:'text',context:contextFor('c.course_id'),
    data:`jsonb_build_object('conversationId',c.conversation_id,'namespace',k.checkpoint_ns,'channel',k.channel,'version',k.version,'type',k.type,'encoding','base64','data',encode(k.blob,'base64'))`},
  checkpoint_writes:{from:conversationFrom+' JOIN chat_memory.checkpoint_writes k ON k.thread_id=c.thread_id',where:'true',key:`jsonb_build_array(k.thread_id,k.checkpoint_ns,k.checkpoint_id,k.task_id,k.idx)::text`,cast:'text',context:contextFor('c.course_id'),
    data:`jsonb_build_object('conversationId',c.conversation_id,'namespace',k.checkpoint_ns,'checkpointId',k.checkpoint_id,'index',k.idx,'channel',k.channel,'type',k.type,'encoding','base64','data',encode(k.blob,'base64'))`},
};
function values(installation:PrivacyInstallation,subject:Subject,contexts:string[]|null) {
  const prefixes=privacyIdentityPrefixes(subject);
  return [installation.ownerUserId,subject.subjectKey,prefixes.qa,prefixes.history,
    subject.registrationId,subject.subjectHash,installation.id,contexts];
}
const scoped=(d:Collection)=>privacyRecordAllowed(d.where,'p.contexts IS NULL',`${d.context}=ANY(p.contexts)`,privacyStringLogic);

/** Complete records are emitted as bounded UTF-8 text fragments; no silent truncation. */
export async function exportPrivacyPart(client:pg.Client,installation:PrivacyInstallation,subject:Subject,
  input:Extract<z.infer<typeof privacyRequest>,{action:'export'}>) {
  const d=defs[input.collection],point=input.cursor?.record;
  const id=privacyRecordCursor(input.cursor);
  const cursorFailure=privacyCursorFailure(input.collection,d.cast==='bigint'?'integer':d.cast==='uuid'?'uuid':'opaque',id,value=>z.uuid().safeParse(value).success);
  if(cursorFailure==='retiredConversation')throw new ApiError(409,'CONFLICT','Conversation export identifiers changed. Restart the export.');
  if(cursorFailure==='invalid')throw new ApiError(400,'VALIDATION_ERROR','Invalid export cursor.');
  const cursorWhere=id ? `AND ${d.key}${point?'=':'>'}$9::${d.cast}` : 'AND $9::text IS NULL';
  const rows=await client.query<{id:string;context:string;chunk:string;total:number;revision:string}>(`${parameters}, candidate AS MATERIALIZED(
    SELECT (${d.key})::text id,${d.context} context,(${d.data})::text data FROM ${d.from}
    WHERE ${scoped(d)} ${cursorWhere} ORDER BY ${d.key} LIMIT 1)
    SELECT id,context,substring(data FROM $10::int+1 FOR ${PRIVACY_EXPORT_CHUNK_CHARACTERS}) chunk,length(data)::int total,
      encode(sha256(convert_to(data,'UTF8')),'hex') revision FROM candidate`,[...values(installation,subject,input.contexts),id??null,point?.offset??0]);
  const result=privacyExportPage(rows.rows[0],point);
  if('changed' in result)throw new ApiError(409,'CONFLICT','Data changed. Restart the export.');
  return result;
}

export async function subjectPrivacyContexts(client:pg.Client,installation:PrivacyInstallation,subject:Subject,after='',contexts:string[]|null=null) {
  const relevant=privacyContextCollections;
  const unions=relevant.map(name=>{const d=defs[name];return `SELECT ${d.context} context FROM ${d.from} WHERE ${scoped(d)}`;});
  const result=await client.query<{context:string}>(`${parameters} SELECT context FROM (SELECT DISTINCT context FROM (${unions.join(' UNION ALL ')}) data) contexts
    WHERE context COLLATE "C">$9 ORDER BY context COLLATE "C" LIMIT ${PRIVACY_CONTEXT_PAGE_SIZE+1}`,[...values(installation,subject,contexts),after]);
  return privacyContextPage(result.rows,row=>row.context);
}

/** Session invalidation and erasure commit together under the owner's exclusive lock. */
export async function erasePrivacyData(client:pg.Client,installation:PrivacyInstallation,subject:Subject,contexts:string[]) {
  const v=values(installation,subject,contexts);
  const result:Record<string,number>={};
  const execute=async(name:string,text:string,args:unknown[]=[])=>{result[name]=(await client.query(parameters+' '+text,[...v,...args])).rowCount??0;};
  // Authentication credentials are never exported. Preserve other subjects/courses.
  const revoked=await client.query<{sessions:string;feedback:string}>(parameters+`, revoked AS(DELETE FROM lti_credentials h USING params p WHERE h.kind='session'
    AND h.payload->>'registrationId'=p.registration AND h.payload->>'subjectHash'=p.subject_hash
    AND coalesce(h.payload->>'contextId','${ORPHAN_CONTEXT}')=ANY(p.contexts) RETURNING h.id),
    feedback AS(DELETE FROM lti_credentials f USING params p WHERE f.kind='lti-feedback' AND (
      f.payload->>'sessionHash' IN(SELECT id FROM revoked) OR f.payload->>'logId' IN(
        SELECT l.id::text FROM chat_logs l JOIN lti_chat_log_subjects s ON s.chat_log_id=l.id
        WHERE s.subject_key=p.subject AND ${contextFor('l.course_id')}=ANY(p.contexts))) RETURNING f.id)
    SELECT (SELECT count(*) FROM revoked) sessions,(SELECT count(*) FROM feedback) feedback`,v);
  result.sessions=Number(revoked.rows[0].sessions);result.feedback=Number(revoked.rows[0].feedback);
  for(const effect of privacyErasurePlan()) {
    switch(effect.target) {
      case 'feedback': case 'sessions': break; // Already applied together above.
      case 'recentHistory':
        await execute(effect.target,`DELETE FROM lti_credentials h USING params p WHERE ${scoped(defs.recent_history)}`);break;
      case 'conversations':
        await execute(effect.target,`DELETE FROM chat_conversations c USING params p,lti_conversation_scopes s
          WHERE s.thread_id=c.thread_id AND s.subject_key=p.subject AND ${contextFor('c.course_id')}=ANY(p.contexts)`);break;
      case 'logs':
        await execute(effect.target,`DELETE FROM chat_logs l USING params p,lti_chat_log_subjects s WHERE s.chat_log_id=l.id AND s.subject_key=p.subject AND ${contextFor('l.course_id')}=ANY(p.contexts)`);break;
      case 'questions': {
        const fields=effect.fields;
        await execute(effect.target,`UPDATE course_questions q SET title=$9,body=$10,lti_author_id=$11,lti_instructor=$12,featured=$13,updated_at=now()
          FROM params p,video_courses c WHERE q.course_id=c.id AND q.lti_author_id=${author('c.id')} AND ${contextFor('c.id')}=ANY(p.contexts)`,
          [fields.title,fields.body,fields.author,fields.instructor,fields.featured]);break;
      }
      case 'replies': {
        const fields=effect.fields;
        await execute(effect.target,`UPDATE course_question_replies r SET body=$9,lti_author_id=$10,lti_instructor=$11,updated_at=now()
          FROM params p,video_courses c,course_questions q WHERE r.question_id=q.id AND q.course_id=c.id
          AND r.lti_author_id=${author('c.id')} AND ${contextFor('c.id')}=ANY(p.contexts)`,[fields.body,fields.author,fields.instructor]);break;
      }
      case 'votes':
        await execute(effect.target,`DELETE FROM course_question_lti_votes a USING params p,video_courses c,course_questions q WHERE a.question_id=q.id AND q.course_id=c.id
          AND a.lti_author_id=${author('c.id')} AND ${contextFor('c.id')}=ANY(p.contexts)`);break;
      case 'moderation':
        await execute(effect.target,`UPDATE course_qa_moderation a SET lti_actor_id=$9 FROM params p,video_courses c WHERE a.course_id=c.id
          AND a.lti_actor_id=${author('c.id')} AND ${contextFor('c.id')}=ANY(p.contexts)`,[effect.actor]);break;
      case 'materialOperations': case 'tagOperations': {
        const barrier=privacyOperationBarriers.find(item=>item.count===effect.target)!;
        const table={material_operations:'lti_material_operations',tag_operations:'lti_course_tag_operations'}[barrier.collection];
        await client.query(parameters+` INSERT INTO lti_operation_reservations(key)
          SELECT ${reservationExpression(barrier.operation,'a.id')} FROM ${table} a,params p,video_courses c WHERE a.course_id=c.id
            AND a.actor_key=p.subject AND ${contextFor('c.id')}=ANY(p.contexts) ORDER BY 1 ON CONFLICT DO NOTHING`,v);
        await execute(effect.target,`DELETE FROM ${table} a USING params p,video_courses c WHERE a.course_id=c.id
          AND a.actor_key=p.subject AND ${contextFor('c.id')}=ANY(p.contexts)`);break;
      }
      case 'reportAccesses':
        await execute(effect.target,`DELETE FROM lti_report_accesses a USING params p,video_courses c
          WHERE a.course_id=c.id AND a.installation_id=p.installation AND a.actor_key=p.subject
            AND ${reportContext('a')}=ANY(p.contexts)`);break;
    }
  }
  return result;
}
