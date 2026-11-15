import {and,eq,gt,sql} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {teachingConnections,lmsInstallations,ltiCredentials,users,videoCourses} from '../../db/schema';
import {activeLmsOwner} from './lms-owner-policy';
import {ticketSchema} from '../../shared/teaching';
import {ApiError} from '../../shared/errors';
import type {Bindings} from '../../types/bindings';
import type {TeachingRepository} from '../contracts/teaching-repository';
const denied=()=>new ApiError(403,'FORBIDDEN','The teaching connection is unavailable.');
export function createPostgresTeachingRepository(env:Bindings):TeachingRepository {
 return {
  async consumeBootstrapNonce(id,expiresAt){if(!Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now())return false;return withDb(env,async db=>(await db.insert(ltiCredentials).values({id,kind:'teaching-link-nonce',payload:{},expiresAt}).onConflictDoNothing().returning({id:ltiCredentials.id})).length===1);},
  findConnection(provider,installationId,contextId){return withDb(env,async db=>{
   const row=(await db.select({link:teachingConnections,courseTitle:videoCourses.name}).from(teachingConnections)
    .innerJoin(users,eq(users.id,teachingConnections.ownerUserId))
    .innerJoin(videoCourses,and(eq(videoCourses.id,teachingConnections.courseId),eq(videoCourses.userId,teachingConnections.ownerUserId)))
    .where(and(eq(teachingConnections.provider,provider),eq(teachingConnections.installationId,installationId),eq(teachingConnections.contextId,contextId),eq(teachingConnections.active,true),activeLmsOwner())))[0];
   return row?{...row.link,createdAt:row.link.createdAt.toISOString(),courseTitle:row.courseTitle}:null;
  });},
  findInstallation(id){return withDb(env,async db=>(await db.select({id:lmsInstallations.id,clientId:lmsInstallations.clientId,deploymentId:lmsInstallations.deploymentId,materialsService:lmsInstallations.materialsService})
   .from(lmsInstallations).where(and(eq(lmsInstallations.id,id),eq(lmsInstallations.active,true))).limit(1))[0]??null);},
  async connect(ticketId,ownerUserId,verified,selectedCourseId){
  return withDb(env, db => db.transaction(async tx => {
    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, ownerUserId), activeLmsOwner())).for('update');
    if (!owner) throw denied();
    const [record] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, ticketId),
      eq(ltiCredentials.kind, 'teaching-connect'), gt(ltiCredentials.expiresAt, new Date()))).for('update');
    const parsed = ticketSchema.safeParse(record?.payload);if (!parsed.success) throw denied();
    const input = parsed.data;
    if(JSON.stringify(input)!==JSON.stringify(verified))throw denied();
    // Serialize different teachers' simultaneous attempts for the same context.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.provider,input.installationId,input.contextId])},0))`);
    const [existing] = await tx.select().from(teachingConnections).where(and(eq(teachingConnections.provider, input.provider),
      eq(teachingConnections.installationId, input.installationId), eq(teachingConnections.contextId, input.contextId))).for('update');
    if (existing && (existing.ownerUserId !== ownerUserId || existing.teacherSubject !== input.teacherSubject ||
      selectedCourseId !== undefined && existing.courseId !== selectedCourseId)) {
      throw new ApiError(409, 'CONFLICT', 'This class is already connected. Ask its owner to manage this connection.');
    }
    if (input.provider === 'moodle') {
      const [site] = await tx.select({ id: lmsInstallations.id }).from(lmsInstallations)
        .where(and(eq(lmsInstallations.id, input.installationId), eq(lmsInstallations.active, true))).for('share');
      if (!site || !input.resourceLinkId) throw denied();
    }
    const courseId = selectedCourseId ?? existing?.courseId;
    if (!courseId) throw denied();
    const [course] = await tx.select({ id: videoCourses.id }).from(videoCourses).where(and(
      eq(videoCourses.id, courseId), eq(videoCourses.userId, ownerUserId), eq(videoCourses.nativeAccessDisabled, false))).for('share');
    if (!course) throw denied();
    if (existing) await tx.update(teachingConnections).set({ active: true, resourceLinkId: input.resourceLinkId ?? null }).where(eq(teachingConnections.id, existing.id));
    else await tx.insert(teachingConnections).values({ provider: input.provider, installationId: input.installationId,
      contextId: input.contextId, teacherSubject: input.teacherSubject, ownerUserId, courseId, resourceLinkId: input.resourceLinkId });
    await tx.delete(ltiCredentials).where(eq(ltiCredentials.id, ticketId));
    return { returnUrl: input.returnUrl, courseId };
  }));
  },
  courses(ownerUserId){return withDb(env,db=>db.select({id:videoCourses.id,name:videoCourses.name}).from(videoCourses)
   .where(and(eq(videoCourses.userId,ownerUserId),eq(videoCourses.nativeAccessDisabled,false))));},
  connections(ownerUserId){return withDb(env,db=>db.select({id:teachingConnections.id,provider:teachingConnections.provider,contextId:teachingConnections.contextId,courseId:teachingConnections.courseId,name:videoCourses.name,active:teachingConnections.active})
   .from(teachingConnections).innerJoin(videoCourses,eq(videoCourses.id,teachingConnections.courseId)).where(eq(teachingConnections.ownerUserId,ownerUserId)));},
  disconnect(id,ownerUserId){return withDb(env,async db=>(await db.update(teachingConnections).set({active:false}).where(and(eq(teachingConnections.id,id),eq(teachingConnections.ownerUserId,ownerUserId))).returning({id:teachingConnections.id})).length===1);},
 };
}
