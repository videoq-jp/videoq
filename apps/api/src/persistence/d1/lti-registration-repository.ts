import {and,eq,inArray,sql} from 'drizzle-orm';
import {createD1Connection} from '../../db/d1/connection';
import {teachingConnections,lmsInstallations,lmsResources,users,videos,videoCourses} from '../../db/schema/sqlite';
import type {LtiRegistrationRepository,LtiPlatform} from '../contracts/lti-registration-repository';
export function createD1LtiRegistrationRepository(database:D1Database):LtiRegistrationRepository {
  const db=createD1Connection(database);
  return {async snapshot(platform?:LtiPlatform){
    const installations=await db.select({id:lmsInstallations.id,ownerUserId:lmsInstallations.ownerUserId,issuer:lmsInstallations.issuer,clientId:lmsInstallations.clientId,
      deploymentId:lmsInstallations.deploymentId,authorizationUrl:lmsInstallations.authorizationUrl,jwksUrl:lmsInstallations.jwksUrl,materialsService:lmsInstallations.materialsService})
      .from(lmsInstallations).where(and(eq(lmsInstallations.active,true),...(platform?[eq(lmsInstallations.issuer,platform.issuer),eq(lmsInstallations.clientId,platform.clientId)]:[])));
    if(!installations.length)return {installations,resources:[],linked:[]};
    const installationIds=installations.map(row=>row.id);
    const resourcesQuery=db.select({installationId:lmsResources.installationId,kind:lmsResources.kind,contextId:lmsResources.contextId,resourceLinkId:lmsResources.resourceLinkId,
      courseId:lmsResources.courseId,videoId:lmsResources.videoId,generation:lmsResources.generation,youtubeVideoId:sql<string|null>`${lmsResources.youtubeVideoId}`.as('resource_youtube_id'),
      status:videos.status,videoOwner:sql<string|null>`${videos.userId}`.as('video_owner'),sourceType:videos.sourceType,actualYoutubeVideoId:sql<string|null>`${videos.youtubeVideoId}`.as('actual_youtube_id'),courseOwner:sql<string>`${videoCourses.userId}`.as('course_owner')})
      .from(lmsResources).innerJoin(videoCourses,and(eq(videoCourses.id,lmsResources.courseId),eq(videoCourses.managedByLms,true),eq(videoCourses.nativeAccessDisabled,true)))
      .innerJoin(teachingConnections,and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,lmsResources.installationId),
        eq(teachingConnections.contextId,lmsResources.contextId),eq(teachingConnections.courseId,videoCourses.id),eq(teachingConnections.active,true),eq(teachingConnections.ownerUserId,videoCourses.userId)))
      .innerJoin(users,eq(users.id,videoCourses.userId)).leftJoin(videos,eq(videos.id,lmsResources.videoId))
      .where(and(eq(lmsResources.enabled,true),inArray(lmsResources.installationId,installationIds),and(eq(users.isActive,true),sql`${users.deactivatedAt} IS NULL AND (${users.banned} IS NOT TRUE OR julianday(${users.banExpires})<=julianday('now'))`)));
    const linkedQuery=db.select({installationId:teachingConnections.installationId,contextId:teachingConnections.contextId,courseId:teachingConnections.courseId,resourceLinkId:teachingConnections.resourceLinkId})
      .from(teachingConnections).innerJoin(videoCourses,and(eq(videoCourses.id,teachingConnections.courseId),eq(videoCourses.userId,teachingConnections.ownerUserId),eq(videoCourses.nativeAccessDisabled,false)))
      .innerJoin(users,eq(users.id,teachingConnections.ownerUserId))
      .where(and(eq(teachingConnections.provider,'moodle'),inArray(teachingConnections.installationId,installationIds),eq(teachingConnections.active,true),and(eq(users.isActive,true),sql`${users.deactivatedAt} IS NULL AND (${users.banned} IS NOT TRUE OR julianday(${users.banExpires})<=julianday('now'))`)));
    const [resources,linked]=await db.batch([resourcesQuery,linkedQuery]);
    return {installations,resources,linked};
  }};
}
