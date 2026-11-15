import {and,eq,sql} from 'drizzle-orm';
import {createD1Connection} from '../../db/d1/connection';
import {teachingConnections,lmsInstallations,ltiCredentials,users,videoCourses} from '../../db/schema/sqlite';
import {ticketSchema} from '../../shared/teaching';
import {ApiError} from '../../shared/errors';
import type {TeachingRepository} from '../contracts/teaching-repository';
const denied=()=>new ApiError(403,'FORBIDDEN','The teaching connection is unavailable.');
const active=sql`${users.isActive}=1 AND ${users.deactivatedAt} IS NULL AND (${users.banned} IS NOT TRUE OR julianday(${users.banExpires})<=julianday('now'))`;
const existingSql=`SELECT json_object('id',id,'ownerUserId',owner_user_id,'teacherSubject',teacher_subject,'courseId',course_id,'resourceLinkId',resource_link_id,'active',active) AS value
 FROM teaching_connections WHERE provider=? AND installation_id=? AND context_id=?`;
type Existing={id:string;ownerUserId:string;teacherSubject:string;courseId:number;resourceLinkId:string|null;active:number};
export function createD1TeachingRepository(database:D1Database):TeachingRepository {
 const db=createD1Connection(database);
 const prepare=(text:string,args:unknown[]=[])=>database.prepare(text).bind(...args);
 return {
  async consumeBootstrapNonce(id,expiresAt){if(!Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now())return false;return (await db.insert(ltiCredentials).values({id,kind:'teaching-link-nonce',payload:{},expiresAt}).onConflictDoNothing().returning({id:ltiCredentials.id})).length===1;},
  async findConnection(provider,installationId,contextId){
   const row=(await db.select({link:teachingConnections,courseTitle:videoCourses.name}).from(teachingConnections)
    .innerJoin(users,eq(users.id,teachingConnections.ownerUserId))
    .innerJoin(videoCourses,and(eq(videoCourses.id,teachingConnections.courseId),eq(videoCourses.userId,teachingConnections.ownerUserId)))
    .where(and(eq(teachingConnections.provider,provider),eq(teachingConnections.installationId,installationId),eq(teachingConnections.contextId,contextId),eq(teachingConnections.active,true),active)))[0];
   return row?{...row.link,createdAt:row.link.createdAt.toISOString(),courseTitle:row.courseTitle}:null;
  },
  async findInstallation(id){return (await db.select({id:lmsInstallations.id,clientId:lmsInstallations.clientId,deploymentId:lmsInstallations.deploymentId,materialsService:lmsInstallations.materialsService})
   .from(lmsInstallations).where(and(eq(lmsInstallations.id,id),eq(lmsInstallations.active,true))).limit(1))[0]??null;},
  async connect(ticketId,ownerUserId,verified,selectedCourseId){
   for(let attempt=0;attempt<5;attempt++){
    const permitted=await db.select({id:users.id}).from(users).where(and(eq(users.id,ownerUserId),active)).limit(1);
    if(!permitted.length)throw denied();
    const raw=await prepare("SELECT payload FROM lti_credentials WHERE id=? AND kind='teaching-connect' AND julianday(expires_at)>julianday('now')",[ticketId]).first<string>('payload');
    const parsed=ticketSchema.safeParse(raw?JSON.parse(raw):null);if(!parsed.success)throw denied();
    const input=parsed.data;if(JSON.stringify(input)!==JSON.stringify(verified))throw denied();
    const context=[input.provider,input.installationId,input.contextId];
    const snapshot=await prepare(existingSql,context).first<string>('value');
    const existing=snapshot?JSON.parse(snapshot) as Existing:null;
    if(existing&&(existing.ownerUserId!==ownerUserId||existing.teacherSubject!==input.teacherSubject||selectedCourseId!==undefined&&existing.courseId!==selectedCourseId))
     throw new ApiError(409,'CONFLICT','This class is already connected. Ask its owner to manage this connection.');
    if(input.provider==='moodle'&&!input.resourceLinkId)throw denied();
    const courseId=selectedCourseId??existing?.courseId;if(!courseId)throw denied();
    const token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
    // The pre-read selects an expected state only. Every permission and the full
    // ticket/connection snapshot are checked again inside this atomic batch.
    const results=await database.batch([
     prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'teaching_connect',? WHERE
      EXISTS(SELECT 1 FROM users owner WHERE owner.id=? AND owner.is_active=1 AND owner.deactivated_at IS NULL
       AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now')))
      AND EXISTS(SELECT 1 FROM lti_credentials WHERE id=? AND kind='teaching-connect' AND payload=? AND julianday(expires_at)>julianday('now'))
      AND (${existingSql}) IS ?
      AND (?<>'moodle' OR EXISTS(SELECT 1 FROM lms_installations WHERE id=? AND active=1))
      AND EXISTS(SELECT 1 FROM video_courses WHERE id=? AND user_id=? AND native_access_disabled=0)`,
      [token,courseId,ownerUserId,ticketId,raw,...context,snapshot,input.provider,input.installationId,courseId,ownerUserId]),
     prepare(`INSERT INTO teaching_connections(id,provider,installation_id,context_id,teacher_subject,owner_user_id,course_id,resource_link_id,active)
      SELECT ?,?,?,?,?,?,?,?,1 WHERE ${gate}
      ON CONFLICT(provider,installation_id,context_id) DO UPDATE SET active=1,resource_link_id=excluded.resource_link_id`,
      [existing?.id??crypto.randomUUID(),...context,input.teacherSubject,ownerUserId,courseId,input.resourceLinkId??null,token]),
     prepare(`DELETE FROM lti_credentials WHERE id=? AND ${gate}`,[ticketId,token]),
     prepare('SELECT token FROM mutation_receipts WHERE token=?',[token]),
     prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
    ]);
    if(results[3].results.length)return {returnUrl:input.returnUrl,courseId};
    // Stable permission failures should not become a misleading retry conflict.
    const owner=await db.select({id:users.id}).from(users).where(and(eq(users.id,ownerUserId),active)).limit(1);
    const course=await db.select({id:videoCourses.id}).from(videoCourses).where(and(eq(videoCourses.id,courseId),eq(videoCourses.userId,ownerUserId),eq(videoCourses.nativeAccessDisabled,false))).limit(1);
    if(!owner.length||!course.length||input.provider==='moodle'&&!await prepare('SELECT id FROM lms_installations WHERE id=? AND active=1',[input.installationId]).first())throw denied();
   }
   throw new ApiError(409,'CONFLICT','The teaching connection changed. Retry the connection.');
  },
  async courses(ownerUserId){return db.select({id:videoCourses.id,name:videoCourses.name}).from(videoCourses)
   .where(and(eq(videoCourses.userId,ownerUserId),eq(videoCourses.nativeAccessDisabled,false)));},
  async connections(ownerUserId){return db.select({id:teachingConnections.id,provider:teachingConnections.provider,contextId:teachingConnections.contextId,courseId:teachingConnections.courseId,name:videoCourses.name,active:teachingConnections.active})
   .from(teachingConnections).innerJoin(videoCourses,eq(videoCourses.id,teachingConnections.courseId)).where(eq(teachingConnections.ownerUserId,ownerUserId));},
  async disconnect(id,ownerUserId){return (await db.update(teachingConnections).set({active:false}).where(and(eq(teachingConnections.id,id),eq(teachingConnections.ownerUserId,ownerUserId))).returning({id:teachingConnections.id})).length===1;},
 };
}
