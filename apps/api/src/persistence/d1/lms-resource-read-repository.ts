import {and,eq,sql} from 'drizzle-orm';
import {createD1Connection} from '../../db/d1/connection';
import {teachingConnections,lmsInstallations,lmsResources,users,videos,videoCourses} from '../../db/schema/sqlite';
import {normalizeLmsResourceData} from '../../shared/lms-resource-values';
import type {LmsResourceReadRepository} from '../contracts/lms-resource-repository';
export function createD1LmsResourceReadRepository(database:D1Database):LmsResourceReadRepository {
 const db=createD1Connection(database);
 return {async get(grant,externalId){
  const where=and(eq(lmsResources.installationId,grant.id),eq(lmsResources.externalId,externalId),grant.ownerUserId?eq(teachingConnections.ownerUserId,grant.ownerUserId):undefined,eq(lmsInstallations.active,true),
   eq(users.isActive,true),sql`${users.deactivatedAt} IS NULL AND (${users.banned} IS NOT TRUE OR julianday(${users.banExpires})<=julianday('now'))`);
  // Select each table separately in one atomic batch: repeated id/source column
  // names in a joined D1 row must not overwrite another table's fields.
  const [resources,media]=await db.batch([
   db.select({resource:lmsResources,ownerUserId:teachingConnections.ownerUserId}).from(lmsResources).innerJoin(lmsInstallations,eq(lmsInstallations.id,lmsResources.installationId))
    .innerJoin(teachingConnections,and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,lmsInstallations.id),eq(teachingConnections.contextId,lmsResources.contextId),eq(teachingConnections.courseId,lmsResources.courseId),eq(teachingConnections.active,true)))
    .innerJoin(videoCourses,and(eq(videoCourses.id,teachingConnections.courseId),eq(videoCourses.userId,teachingConnections.ownerUserId)))
    .innerJoin(users,eq(users.id,teachingConnections.ownerUserId)).where(where).limit(1),
   db.select({video:videos}).from(lmsResources).innerJoin(lmsInstallations,eq(lmsInstallations.id,lmsResources.installationId)).innerJoin(teachingConnections,and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,lmsInstallations.id),eq(teachingConnections.contextId,lmsResources.contextId),eq(teachingConnections.courseId,lmsResources.courseId),eq(teachingConnections.active,true)))
    .innerJoin(videoCourses,and(eq(videoCourses.id,teachingConnections.courseId),eq(videoCourses.userId,teachingConnections.ownerUserId)))
    .innerJoin(users,eq(users.id,teachingConnections.ownerUserId))
    .innerJoin(videos,and(eq(videos.id,lmsResources.videoId),eq(videos.userId,teachingConnections.ownerUserId))).where(where).limit(1),
  ]);
  const row=resources[0];return row?normalizeLmsResourceData({...row,video:media[0]?.video??null}):null;
 }};
}
