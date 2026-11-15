import {chatAnswerSchema,chatAnswerText} from "@videoq/trpc/chat";
import type {ChatRepository,ChatLogItem,ChatQuestionAuthor} from "../contracts/chat-repository";
import {checkedLtiSubject} from "../../features/lti/identity";
import {toUtcIso} from "../../shared/datetime";
import {NATIVE_COURSE_EXTERNAL} from "./course-access";
const NOW="strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'";
type LogRow={id:number;course_id:number;user_id:string;username:string|null;email:string|null;question:string;response:string;is_shared_origin:number;feedback:string|null;created_at:string;classroom_author:string|null};
const author=(r:LogRow):ChatQuestionAuthor|null=>r.classroom_author!==null?JSON.parse(r.classroom_author) as ChatQuestionAuthor:r.is_shared_origin || r.username===null || r.email===null?null:{user_id:r.user_id,username:r.username,email:r.email};
const feedback=(value:unknown)=>value==='good'||value==='bad'?value:null;
const logItem=(r:LogRow):ChatLogItem=>({id:r.id,course:r.course_id,asked_by:author(r),question:r.question,answer:chatAnswerSchema.parse(JSON.parse(r.response)),
  is_shared_origin:Boolean(r.is_shared_origin),feedback:feedback(r.feedback),created_at:toUtcIso(r.created_at)});
const PROJECTION="log.id,log.course_id,log.user_id,u.username,u.email,log.question,log.response,log.is_shared_origin,log.feedback,log.created_at,ls.classroom_author";
export function d1ChatLogStatements(database:D1Database,params:import("../contracts/chat-repository").CreateChatLogInput,token:string,
  guard:{sql:string;values:unknown[]}={sql:'1',values:[]}) {
      const answer=JSON.stringify(chatAnswerSchema.parse(params.answer));
      const subject=params.ltiSubject?checkedLtiSubject(params.ltiSubject):undefined;
      if (subject && !params.isShared) throw new Error('LTI attribution requires an external course grant');
      const proof=subject?.sessionProof;
      const permission=proof?`EXISTS(SELECT 1 FROM users owner JOIN lti_credentials c ON c.id=? WHERE owner.id=? AND c.kind='session'
        AND julianday(c.expires_at)>julianday('now') AND json_extract(c.payload,'$.registrationId')=? AND json_extract(c.payload,'$.subjectHash')=?)`:'1';
      const statements=[
        database.prepare(`INSERT INTO chat_logs(user_id,course_id,question,response,retrieved_contexts,is_shared_origin,feedback,created_at)
          SELECT ?,?,?,?,?,?,NULL,${NOW} WHERE ${permission} AND (${guard.sql})`)
          .bind(params.userId,params.courseId,params.question,answer,JSON.stringify(params.retrievedContexts),params.isShared?1:0,
            ...(proof?[proof.sessionHash,params.userId,proof.registrationId,proof.subjectHash]:[]),...guard.values),
        database.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'chat_create',last_insert_rowid() WHERE changes()=1").bind(token),
      ];
      if (subject) statements.push(database.prepare(`INSERT INTO lti_chat_log_subjects(chat_log_id,subject_key,resource_video_ids,registration_id,context_id,classroom_author)
        SELECT receipt.resource_id,?,?,CASE WHEN CAST(json_extract(c.payload,'$.courseId') AS TEXT)=? AND json_extract(c.payload,'$.registrationId') LIKE 'db:%'
          THEN json_extract(c.payload,'$.registrationId') END,
          CASE WHEN CAST(json_extract(c.payload,'$.courseId') AS TEXT)=? AND json_extract(c.payload,'$.registrationId') LIKE 'db:%'
          THEN json_extract(c.payload,'$.contextId') END,
          CASE WHEN json_extract(c.payload,'$.transport')='classroom' AND CAST(json_extract(c.payload,'$.courseId') AS TEXT)=?
            THEN c.payload -> '$.classroomAuthor'
          WHEN json_extract(c.payload,'$.transport')='native' AND CAST(json_extract(c.payload,'$.courseId') AS TEXT)=?
            THEN c.payload -> '$.moodleAuthor' END
        FROM mutation_receipts receipt LEFT JOIN lti_credentials c ON c.id=? WHERE receipt.token=?`)
        .bind(subject.subjectKey,JSON.stringify(subject.resourceVideoIds),String(params.courseId),String(params.courseId),String(params.courseId),String(params.courseId),proof?.sessionHash??null,token));
      return statements;
}
export function createD1ChatRepository(database:D1Database):ChatRepository {
  return {
    async context(params) {
      const lti=params.ltiCourseGrant===params.courseId;
      if (!lti && !params.shareToken && !params.userId) return null;
      const permission=lti?`EXISTS(SELECT 1 FROM users owner WHERE owner.id=course.user_id AND owner.is_active=1 AND owner.deactivated_at IS NULL
        AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now')))`
        :params.shareToken?`course.share_slug=? AND ${NATIVE_COURSE_EXTERNAL}`
        :`(course.user_id=? OR (${NATIVE_COURSE_EXTERNAL} AND EXISTS(SELECT 1 FROM video_course_memberships WHERE course_id=course.id AND user_id=?)))`;
      const args=lti?[]:params.shareToken?[params.shareToken]:[params.userId??null,params.userId??null];
      const results=await database.batch<{id:number;userId:string;videoId:number}>([
        database.prepare(`SELECT course.id,course.user_id AS userId FROM video_courses course WHERE course.id=? AND ${permission}`).bind(params.courseId,...args),
        database.prepare(`SELECT member.video_id AS videoId FROM video_course_members member JOIN video_courses course ON course.id=member.course_id
          WHERE course.id=? AND ${permission} ORDER BY member."order",member.id`).bind(params.courseId,...args),
      ]);
      const course=results[0].results[0];
      return course?{id:course.id,userId:course.userId,memberVideoIds:results[1].results.map(r=>r.videoId).filter(id=>!lti || params.ltiVideoGrant===undefined || params.ltiVideoGrant.includes(id))}:null;
    },
    async create(params) {
      const token=crypto.randomUUID();
      const statements=d1ChatLogStatements(database,params,token);
      statements.push(database.prepare('SELECT log.id,log.feedback FROM chat_logs log JOIN mutation_receipts receipt ON receipt.resource_id=log.id WHERE receipt.token=?').bind(token));
      statements.push(database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token));
      const results=await database.batch<{id:number;feedback:string|null}>(statements);
      const row=results[results.length-2].results[0];
      if (!row) throw new Error('Missing attributed chat log');
      return {id:row.id,feedback:feedback(row.feedback)};
    },
    async deleteHistory(courseId,userId) {
      const token=crypto.randomUUID();
      const result=await database.batch([
        database.prepare("INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'chat_delete',id FROM video_courses WHERE id=? AND user_id=?").bind(token,courseId,userId),
        database.prepare('DELETE FROM chat_conversations WHERE course_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(courseId,token),
        database.prepare('DELETE FROM chat_logs WHERE course_id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)').bind(courseId,token),
        database.prepare('SELECT token FROM mutation_receipts WHERE token=?').bind(token),
        database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token),
      ]);
      return result[3].results.length?{ok:true}:{notFound:true};
    },
    async exportPage(courseId,userId,cursor) {
      const rows=(await database.prepare(`SELECT ${PROJECTION} FROM chat_logs log JOIN video_courses course ON course.id=log.course_id
        LEFT JOIN users u ON u.id=log.user_id LEFT JOIN lti_chat_log_subjects ls ON ls.chat_log_id=log.id WHERE course.id=? AND course.user_id=?
        AND (? IS NULL OR log.created_at>? OR (log.created_at=? AND log.id>?)) ORDER BY log.created_at,log.id LIMIT 100`)
        .bind(courseId,userId,cursor?.createdAt??null,cursor?.createdAt??null,cursor?.createdAt??null,cursor?.id??null).all<LogRow>()).results;
      const last=rows.at(-1);
      return {rows:rows.map(r=>{const answer=chatAnswerSchema.parse(JSON.parse(r.response));return {created_at:toUtcIso(r.created_at),asked_by:author(r),question:r.question,
        answer:chatAnswerText(answer),is_shared_origin:Boolean(r.is_shared_origin),citations:answer.sources,feedback:r.feedback};}),
        nextCursor:rows.length===100 && last?{createdAt:last.created_at,id:last.id}:null};
    },
    async feedback(logId,value,options) {
      const permission=options.ltiCourseGrant!==undefined?'log.course_id=? AND log.is_shared_origin=1'
        :options.shareSlug?`course.share_slug=? AND log.is_shared_origin=1 AND ${NATIVE_COURSE_EXTERNAL}`
        :`course.user_id=? OR (log.user_id=? AND ${NATIVE_COURSE_EXTERNAL})`;
      const args=options.ltiCourseGrant!==undefined?[options.ltiCourseGrant]:options.shareSlug?[options.shareSlug]:[options.userId??null,options.userId??null];
      const token=crypto.randomUUID();
      const results=await database.batch<{effect_applied:number;id:number;feedback:string|null}>([
        database.prepare(`INSERT INTO mutation_receipts(token,kind,resource_id,effect_applied) SELECT ?,'chat_feedback',log.id,coalesce((${permission}),0)
          FROM chat_logs log JOIN video_courses course ON course.id=log.course_id WHERE log.id=?`).bind(token,...args,logId),
        database.prepare('UPDATE chat_logs SET feedback=? WHERE id=? AND EXISTS(SELECT 1 FROM mutation_receipts WHERE token=? AND effect_applied=1)').bind(value,logId,token),
        database.prepare('SELECT receipt.effect_applied,log.id,log.feedback FROM mutation_receipts receipt LEFT JOIN chat_logs log ON log.id=receipt.resource_id WHERE receipt.token=?').bind(token),
        database.prepare('DELETE FROM mutation_receipts WHERE token=?').bind(token),
      ]);
      const row=results[2].results[0];
      if (!row || row.id===null) return {notFound:true};
      if (!row.effect_applied) return {forbidden:true};
      return {id:row.id,feedback:feedback(row.feedback)};
    },
    async shareExists(slug) {
      return Boolean(await database.prepare(`SELECT 1 FROM video_courses course WHERE course.share_slug=? AND ${NATIVE_COURSE_EXTERNAL}`).bind(slug).first());
    },
    async analytics(courseId,userId) {
      const results=await database.batch<{date:string;count:number;first:string;last:string;good:number;bad:number;none:number}>([
        database.prepare('SELECT id FROM video_courses WHERE id=? AND user_id=?').bind(courseId,userId),
        database.prepare(`SELECT substr(log.created_at,1,10) AS date,count(*) AS count,min(log.created_at) AS first,max(log.created_at) AS last,
          count(*) FILTER(WHERE log.feedback='good') AS good,count(*) FILTER(WHERE log.feedback='bad') AS bad,count(*) FILTER(WHERE log.feedback IS NULL) AS none
          FROM chat_logs log JOIN video_courses course ON course.id=log.course_id WHERE course.id=? AND course.user_id=? GROUP BY substr(log.created_at,1,10) ORDER BY date`).bind(courseId,userId),
      ]);
      if (!results[0].results.length) return {notFound:true};
      const rows=results[1].results;
      return {summary:{total_questions:rows.reduce((sum,r)=>sum+r.count,0),date_range:{first:rows[0]?toUtcIso(rows[0].first):null,last:rows.at(-1)?toUtcIso(rows.at(-1)!.last):null}},
        time_series:rows.map(r=>({date:r.date,count:r.count})),feedback:{good:rows.reduce((n,r)=>n+r.good,0),bad:rows.reduce((n,r)=>n+r.bad,0),none:rows.reduce((n,r)=>n+r.none,0)}};
    },
    async history(courseId,userId,limit,offset) {
      if (!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(offset)||offset<0) throw new Error('Invalid history pagination');
      const results=await database.batch<LogRow & {count:number}>([
        database.prepare('SELECT (SELECT count(*) FROM chat_logs WHERE course_id=course.id) AS count FROM video_courses course WHERE course.id=? AND course.user_id=?').bind(courseId,userId),
        database.prepare(`SELECT ${PROJECTION} FROM chat_logs log JOIN video_courses course ON course.id=log.course_id LEFT JOIN users u ON u.id=log.user_id LEFT JOIN lti_chat_log_subjects ls ON ls.chat_log_id=log.id
          WHERE course.id=? AND course.user_id=? ORDER BY log.created_at DESC,log.id DESC LIMIT ? OFFSET ?`).bind(courseId,userId,limit,offset),
      ]);
      const total=results[0].results[0];
      return total?{count:total.count,results:results[1].results.map(logItem)}:{notFound:true};
    },
  };
}
