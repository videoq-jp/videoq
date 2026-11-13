import {and,eq,inArray,sql} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {chatLogs,ltiCredentials,videoCourseMembers} from '../../db/schema';
import {lockLtiDataSessionWithDb} from './lti-session-lock';
import {savedCourseHistory,checkHistoryScope,historyDenied} from '../../shared/course-history';
import type {Bindings} from '../../types/bindings';
import type {CourseHistoryRepository} from '../contracts/course-history-repository';
export function createPostgresCourseHistoryRepository(env:Bindings):CourseHistoryRepository{return {
 async append(scope,id,turn,allowed,expiresAt){
  checkHistoryScope(scope);
  await withDb(env, database => database.transaction(async db => {
    if (scope.sessionProof) {
      const result = await db.execute<{user_id:string}>(sql`SELECT user_id FROM video_courses WHERE id=${scope.courseId}`);
      if (!result.rows[0]) throw historyDenied();
      await lockLtiDataSessionWithDb(db,result.rows[0].user_id,scope.sessionProof);
    }
    const members = allowed ?? (await db.select({ id: videoCourseMembers.videoId }).from(videoCourseMembers).where(eq(videoCourseMembers.courseId, scope.courseId))).map(row => row.id);
    const scopeJson = JSON.stringify([...new Set(members)].sort((a,b) => a-b));
    // Atomic append protects simultaneous pages. A reduced permission scope drops
    // prior context instead of exposing answers from newly restricted videos.
    const previous = sql`CASE WHEN ${ltiCredentials.expiresAt} > clock_timestamp() AND jsonb_typeof(${ltiCredentials.payload}->'scopeVideoIds')='array' AND jsonb_typeof(${ltiCredentials.payload}->'turns')='array' AND (${ltiCredentials.payload}->'scopeVideoIds') <@ ${scopeJson}::jsonb
      THEN coalesce(${ltiCredentials.payload}->'turns', '[]'::jsonb) ELSE '[]'::jsonb END`;
    const attribution={registrationId:scope.registrationId,subjectHash:scope.subjectHash,courseId:scope.courseId,...(scope.contextId?{contextId:scope.contextId}:{})};
    const changed=await db.insert(ltiCredentials).values({ id, kind: "lti-history", payload: { ...attribution,scopeVideoIds: JSON.parse(scopeJson) as number[], turns: [turn] }, expiresAt })
      .onConflictDoUpdate({ target: ltiCredentials.id, set: { expiresAt, payload: sql`${JSON.stringify(attribution)}::jsonb || jsonb_build_object('scopeVideoIds', ${scopeJson}::jsonb, 'turns',
        (SELECT jsonb_agg(item ORDER BY ord) FROM (SELECT item, ord FROM jsonb_array_elements((${previous}) || ${JSON.stringify([turn])}::jsonb)
          WITH ORDINALITY AS entries(item,ord) ORDER BY ord DESC LIMIT 50) recent))` }, setWhere:eq(ltiCredentials.kind,'lti-history') }).returning({id:ltiCredentials.id});
    if(!changed.length)throw historyDenied();
  }));
 },
 async read(scope,id,ownerUserId){
  checkHistoryScope(scope);
  return withDb(env,database=>database.transaction(async db=>{
   await lockLtiDataSessionWithDb(db,ownerUserId,scope.sessionProof);
   const [row]=await db.select({payload:ltiCredentials.payload}).from(ltiCredentials)
    .where(and(eq(ltiCredentials.id,id),eq(ltiCredentials.kind,'lti-history'),sql`${ltiCredentials.expiresAt}>clock_timestamp()`)).for('share').limit(1);
   if(!row)return null;
   const record=savedCourseHistory.safeParse(row.payload);if(!record.success||!record.data.turns.length)return {payload:row.payload,logs:[]};
   const logs=await db.select({id:chatLogs.id,answer:chatLogs.response,feedback:chatLogs.feedback}).from(chatLogs)
    .where(and(eq(chatLogs.userId,ownerUserId),eq(chatLogs.courseId,scope.courseId),inArray(chatLogs.id,record.data.turns.map(t=>t.logId))));
   return {payload:row.payload,logs};
  }));
 },
};}
