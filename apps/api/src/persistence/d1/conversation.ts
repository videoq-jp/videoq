import {apiConflict,apiNotFound,ApiError} from '../../shared/errors';
import type {ConversationRepository,ConversationSummary,ConversationTurn} from '../contracts/conversation';
import {toUtcIso} from '../../shared/datetime';
import {chatAnswerSchema} from "@videoq/trpc/chat";
import {checkedLtiSubject} from "../../features/lti/identity";
import {conversationThreadId} from "../../shared/conversation-scope";
import {ConversationBusyError,ConversationNotFoundError,type ConversationScope,type OpenConversation} from "../contracts/conversation";
import {D1CheckpointSaver} from "./checkpoint-saver";
import {d1ChatLogStatements} from "./chat-repository";
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function sessionGuard(scope:ConversationScope) {
  const proof=scope.ltiSubject?checkedLtiSubject(scope.ltiSubject).sessionProof:undefined;
  return proof?{sql:`EXISTS(SELECT 1 FROM users owner JOIN lti_credentials c ON c.id=? WHERE owner.id=? AND c.kind='session'
    AND julianday(c.expires_at)>julianday('now') AND json_extract(c.payload,'$.registrationId')=? AND json_extract(c.payload,'$.subjectHash')=?)`,
    values:[proof.sessionHash,scope.ownerUserId,proof.registrationId,proof.subjectHash]}:{sql:'1',values:[]};
}
function scopeFailure(sessionAllowed:number):never {
  if(!sessionAllowed)throw new ApiError(403,'FORBIDDEN','The Moodle session is unavailable.');
  throw new ConversationNotFoundError();
}
function scopeGuard(scope:ConversationScope,threadId:string,allowEmpty=false,ignoreStored=false) {
  if(!scope.ltiSubject)return {sql:'1',values:[] as unknown[]};
  const subject=checkedLtiSubject(scope.ltiSubject);
  const ids=JSON.stringify(subject.resourceVideoIds);
  const proof=subject.sessionProof;
  return {sql:`? >= ${allowEmpty?0:1} AND EXISTS(SELECT 1 FROM video_courses WHERE id=? AND user_id=?)
    AND (SELECT count(*) FROM video_course_members m JOIN videos v ON v.id=m.video_id
      WHERE m.course_id=? AND v.user_id=? AND m.video_id IN(SELECT value FROM json_each(?)))=?
    AND (?=1 OR NOT EXISTS(SELECT 1 FROM lti_conversation_scopes s WHERE s.thread_id=? AND EXISTS(SELECT 1 FROM chat_conversations live WHERE live.thread_id=s.thread_id AND julianday(live.expires_at)>=julianday('now')) AND (s.subject_key<>? OR EXISTS(
      SELECT 1 FROM json_each(s.resource_video_ids) previous WHERE previous.value NOT IN(SELECT value FROM json_each(?))))))
    ${proof?`AND EXISTS(SELECT 1 FROM users owner JOIN lti_credentials c ON c.id=? WHERE owner.id=? AND c.kind='session'
      AND julianday(c.expires_at)>julianday('now') AND json_extract(c.payload,'$.registrationId')=? AND json_extract(c.payload,'$.subjectHash')=?)`:''}`,
    values:[subject.resourceVideoIds.length,scope.courseId,scope.ownerUserId,scope.courseId,scope.ownerUserId,ids,subject.resourceVideoIds.length,ignoreStored?1:0,threadId,subject.subjectKey,ids,
      ...(proof?[proof.sessionHash,scope.ownerUserId,proof.registrationId,proof.subjectHash]:[])]};
}
export async function openD1Conversation(database:D1Database,scope:ConversationScope,conversationId:string,requireExisting=false):Promise<OpenConversation> {
  const threadId=await conversationThreadId(scope,conversationId),scopeKey=await conversationThreadId(scope,'scope');
  const leaseId=crypto.randomUUID(),token=crypto.randomUUID();
  const guard=scopeGuard(scope,threadId),session=sessionGuard(scope);
  const statements=[
    database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'conversation_open',0 WHERE (${guard.sql})
      AND (?=0 OR EXISTS(SELECT 1 FROM chat_conversations WHERE thread_id=? AND julianday(expires_at)>julianday('now')))`)
      .bind(token,...guard.values,requireExisting?1:0,threadId),
    database.prepare('DELETE FROM chat_conversations WHERE thread_id=? AND julianday(expires_at)<julianday(\'now\') AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(threadId,token),
    database.prepare(`INSERT INTO chat_conversations(thread_id,owner_user_id,actor_user_id,course_id,lease_id,conversation_id,scope_key,leased_until,expires_at)
      SELECT ?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+20 minutes'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')
      WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) ON CONFLICT(thread_id) DO UPDATE SET
        lease_id=excluded.lease_id,leased_until=excluded.leased_until,expires_at=excluded.expires_at,conversation_id=excluded.conversation_id,scope_key=excluded.scope_key
      WHERE chat_conversations.lease_id IS NULL OR julianday(chat_conversations.leased_until)<julianday('now')`)
      .bind(threadId,scope.ownerUserId,scope.actorUserId,scope.courseId,leaseId,conversationId,scopeKey,token),
    database.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'conversation_lease',0 WHERE changes()=1").bind(token+':lease'),
  ];
  if(scope.ltiSubject){const subject=checkedLtiSubject(scope.ltiSubject);statements.push(database.prepare(`INSERT INTO lti_conversation_scopes(thread_id,subject_key,resource_video_ids)
    SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) ON CONFLICT(thread_id) DO NOTHING`)
    .bind(threadId,subject.subjectKey,JSON.stringify(subject.resourceVideoIds),token+':lease'));}
  statements.push(database.prepare('SELECT committed_checkpoint_id FROM chat_conversations WHERE thread_id=? AND lease_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(threadId,leaseId,token+':lease'),
    database.prepare(`SELECT (${session.sql}) AS session_allowed,EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AS eligible`).bind(...session.values,token),database.prepare('DELETE FROM mutation_receipts WHERE token IN (?,?)').bind(token,token+':lease'));
  const opened=await database.batch<{committed_checkpoint_id:string|null;session_allowed:number;eligible:number}>(statements);
  const row=opened[opened.length-3].results[0];
  if(!row){const access=opened[opened.length-2].results[0];if(!access.session_allowed)scopeFailure(0);if(access.eligible)throw new ConversationBusyError();throw new ConversationNotFoundError();}
  return {threadId,checkpointId:row.committed_checkpoint_id,saver:new D1CheckpointSaver(database,{threadId,leaseId}),
    async commit(result,prepareLog) {
      if(!result.checkpointId)throw new Error('Missing conversation checkpoint');
      const logInput=prepareLog?await prepareLog(result):null;
      const answer=JSON.stringify(chatAnswerSchema.parse(result.answer));
      const commitToken=crypto.randomUUID(),logToken=commitToken+':log';
      const current=scopeGuard(scope,threadId);
      const batch=[database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'conversation_scope',0 WHERE (${current.sql})`).bind(commitToken+':scope',...current.values),
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'conversation_commit',0
        WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AND EXISTS(SELECT 1 FROM chat_conversations WHERE thread_id=? AND lease_id=? AND julianday(leased_until)>julianday('now'))
          AND EXISTS(SELECT 1 FROM conversation_checkpoints WHERE thread_id=? AND namespace='' AND checkpoint_id=?)`)
        .bind(commitToken,commitToken+':scope',threadId,leaseId,threadId,result.checkpointId)];
      if(logInput)batch.push(...d1ChatLogStatements(database,logInput,logToken,{sql:'EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)',values:[commitToken]}));
      if(scope.ltiSubject)batch.push(database.prepare('UPDATE lti_conversation_scopes SET resource_video_ids=? WHERE thread_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AND (?=0 OR EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?))')
        .bind(JSON.stringify(checkedLtiSubject(scope.ltiSubject).resourceVideoIds),threadId,commitToken,logInput?1:0,logToken));
      batch.push(database.prepare(`INSERT INTO chat_conversation_turns(thread_id,checkpoint_id,question,response,chat_log_id)
        SELECT ?,?,?,?,(SELECT resource_id FROM mutation_receipts WHERE token=?) WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
          AND (?=0 OR EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?))`)
        .bind(threadId,result.checkpointId,result.queryText,answer,logToken,commitToken,logInput?1:0,logToken),
        database.prepare(`UPDATE chat_conversations SET committed_checkpoint_id=?,title=CASE WHEN title='' THEN ? ELSE title END,updated_at=${NOW},expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')
          WHERE thread_id=? AND lease_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)
          AND (?=0 OR EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?))`)
          .bind(result.checkpointId,result.queryText.trim().slice(0,120),threadId,leaseId,commitToken,logInput?1:0,logToken),
        database.prepare(`SELECT receipt.token,(SELECT resource_id FROM mutation_receipts WHERE token=?) AS chat_log_id
          FROM mutation_receipts receipt WHERE receipt.token=? AND (?=0 OR EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?))`).bind(logToken,commitToken,logInput?1:0,logToken),
        database.prepare(`SELECT (${session.sql}) AS session_allowed,EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AS scope_allowed`).bind(...session.values,commitToken+':scope'),
        database.prepare('DELETE FROM mutation_receipts WHERE token IN (?,?,?)').bind(commitToken,logToken,commitToken+':scope'));
      const committed=await database.batch<{chat_log_id:number|null;session_allowed:number;scope_allowed:number}>(batch);
      const saved=committed[committed.length-3].results[0];
      const access=committed[committed.length-2].results[0];
      if(!access.scope_allowed)scopeFailure(access.session_allowed);
      if(!saved)throw new ConversationBusyError();
      return {chatLogId:saved.chat_log_id,feedback:null};
    },
    async close(){await database.prepare('UPDATE chat_conversations SET lease_id=NULL,leased_until=NULL WHERE thread_id=? AND lease_id=?').bind(threadId,leaseId).run();},
  };
}

/** Retention and attributed-log cleanup share the same atomic D1 batch. */
export async function pruneD1Conversations(database:D1Database):Promise<number> {
  const result=await database.batch([
    database.prepare(`DELETE FROM chat_logs WHERE EXISTS(SELECT 1 FROM lti_chat_log_subjects s WHERE s.chat_log_id=chat_logs.id) AND (
      EXISTS(SELECT 1 FROM chat_conversation_turns t JOIN chat_conversations c ON c.thread_id=t.thread_id
        WHERE t.chat_log_id=chat_logs.id AND julianday(c.expires_at)<julianday('now')) OR
      (julianday(created_at)<julianday('now','-30 days') AND NOT EXISTS(
        SELECT 1 FROM chat_conversation_turns t JOIN chat_conversations c ON c.thread_id=t.thread_id
        WHERE t.chat_log_id=chat_logs.id AND julianday(c.expires_at)>=julianday('now'))))`),
    database.prepare("DELETE FROM chat_conversations WHERE julianday(expires_at)<julianday('now') RETURNING thread_id"),
  ]);
  return result[1].results.length;
}

type SummaryRow={id:string;title:string;createdAt:string;updatedAt:string;isGenerating:number};
const SUMMARY_COLUMNS=`conversation_id AS id,title,created_at AS createdAt,updated_at AS updatedAt,
  (lease_id IS NOT NULL AND julianday(leased_until)>julianday('now')) AS isGenerating`;
const summary=(row:SummaryRow):ConversationSummary=>({...row,createdAt:toUtcIso(row.createdAt),updatedAt:toUtcIso(row.updatedAt),isGenerating:Boolean(row.isGenerating)});
function visibleScope(scope:ConversationScope){
  if(!scope.ltiSubject)return {sql:'1',values:[] as unknown[]};
  const subject=checkedLtiSubject(scope.ltiSubject);
  return {sql:`EXISTS(SELECT 1 FROM lti_conversation_scopes s WHERE s.thread_id=chat_conversations.thread_id AND s.subject_key=?
    AND NOT EXISTS(SELECT 1 FROM json_each(s.resource_video_ids) previous WHERE previous.value NOT IN(SELECT value FROM json_each(?))))`,
    values:[subject.subjectKey,JSON.stringify(subject.resourceVideoIds)]};
}
export function createD1ConversationRepository(database:D1Database):ConversationRepository {
  return {
    async list(scope,input){
      const scopeKey=await conversationThreadId(scope,'scope'),guard=scopeGuard(scope,'',true,true),visible=visibleScope(scope);
      const ids=scope.shareSlug?JSON.stringify(input.conversationIds??[]):null,session=sessionGuard(scope);
      const batch=await database.batch<SummaryRow & {allowed:number;session_allowed:number}>([
        database.prepare(`SELECT (${guard.sql}) AS allowed,(${session.sql}) AS session_allowed`).bind(...guard.values,...session.values),
        database.prepare(`SELECT ${SUMMARY_COLUMNS} FROM chat_conversations WHERE scope_key=? AND julianday(expires_at)>julianday('now')
          AND committed_checkpoint_id IS NOT NULL AND (? IS NULL OR conversation_id IN(SELECT value FROM json_each(?)))
          AND (${guard.sql}) AND (${visible.sql}) ORDER BY updated_at DESC,thread_id DESC LIMIT ? OFFSET ?`)
          .bind(scopeKey,ids,ids,...guard.values,...visible.values,input.limit+1,input.offset),
      ]);
      if(!batch[0].results[0]?.allowed)scopeFailure(batch[0].results[0]?.session_allowed);
      return {items:batch[1].results.slice(0,input.limit).map(summary),hasMore:batch[1].results.length>input.limit};
    },
    async detail(scope,input){
      const threadId=await conversationThreadId(scope,input.conversationId),guard=scopeGuard(scope,threadId,true),visible=visibleScope(scope);
      const permission=`thread_id=? AND julianday(expires_at)>julianday('now') AND (${guard.sql}) AND (${visible.sql})`;
      const values=[threadId,...guard.values,...visible.values],session=sessionGuard(scope),current=scopeGuard(scope,threadId,true,true);
      const results=await database.batch<SummaryRow & {allowed:number;session_allowed:number;question:string;response:string;chatLogId:number|null;feedback:'good'|'bad'|null}>([
        database.prepare(`SELECT (${current.sql}) AS allowed,(${session.sql}) AS session_allowed`).bind(...current.values,...session.values),
        database.prepare(`SELECT ${SUMMARY_COLUMNS} FROM chat_conversations WHERE ${permission}`).bind(...values),
        database.prepare(`SELECT CAST(t.id AS TEXT) AS id,t.question,t.response,t.created_at AS createdAt,t.chat_log_id AS chatLogId,l.feedback
          FROM chat_conversation_turns t LEFT JOIN chat_logs l ON l.id=t.chat_log_id WHERE t.thread_id=? AND (? IS NULL OR t.id<CAST(? AS INTEGER))
          AND EXISTS(SELECT 1 FROM chat_conversations WHERE ${permission}) ORDER BY t.id DESC LIMIT ?`)
          .bind(threadId,input.beforeTurnId??null,input.beforeTurnId??null,...values,input.limit+1),
      ]);
      if(!results[0].results[0]?.allowed)scopeFailure(results[0].results[0]?.session_allowed);
      const row=results[1].results[0];if(!row)throw apiNotFound('Conversation not found.');
      const turns:ConversationTurn[]=results[2].results.slice(0,input.limit).reverse().map(t=>({id:t.id,question:t.question,
        answer:chatAnswerSchema.parse(JSON.parse(t.response)),createdAt:toUtcIso(t.createdAt),chatLogId:t.chatLogId,feedback:t.feedback}));
      return {...summary(row),turns,hasMore:results[2].results.length>input.limit};
    },
    async delete(scope,id){
      const threadId=await conversationThreadId(scope,id),guard=scopeGuard(scope,threadId,true,true),token=crypto.randomUUID(),session=sessionGuard(scope);
      const result=await database.batch<{busy:number;eligible:number;session_allowed:number}>([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'conversation_delete',0 WHERE (${guard.sql})`).bind(token,...guard.values),
        database.prepare(`SELECT (lease_id IS NOT NULL AND julianday(leased_until)>julianday('now')) AS busy FROM chat_conversations
          WHERE thread_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(threadId,token),
        database.prepare(`DELETE FROM chat_logs WHERE id IN(SELECT t.chat_log_id FROM chat_conversation_turns t JOIN chat_conversations c ON c.thread_id=t.thread_id
          WHERE c.thread_id=? AND (c.lease_id IS NULL OR julianday(c.leased_until)<=julianday('now')))
          AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(threadId,token),
        database.prepare(`DELETE FROM chat_conversations WHERE thread_id=? AND (lease_id IS NULL OR julianday(leased_until)<=julianday('now'))
          AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)`).bind(threadId,token),
        database.prepare(`SELECT (${session.sql}) AS session_allowed,EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AS eligible`).bind(...session.values,token),
        database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token),
      ]);
      if(!result[4].results[0]?.eligible)scopeFailure(result[4].results[0]?.session_allowed);
      if(result[1].results[0]?.busy)throw apiConflict('Wait for the current answer to finish before deleting this conversation.','CONVERSATION_BUSY');
      return {success:true};
    },
  };
}
