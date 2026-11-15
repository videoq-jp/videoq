import {and,eq,inArray} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {activeLmsOwner} from './lms-owner-policy';
import type {Bindings} from '../../types/bindings';
import {teachingConnections,lmsInstallations,lmsResources,users,videos,videoCourses} from '../../db/schema';
import type {LtiRegistrationRepository,LtiPlatform} from '../contracts/lti-registration-repository';
export function createPostgresLtiRegistrationRepository(env:Bindings):LtiRegistrationRepository {
  return {snapshot:(platform?:LtiPlatform)=>withDb(env,async db=>{
    const installations=await db.select({id:lmsInstallations.id,ownerUserId:lmsInstallations.ownerUserId,issuer:lmsInstallations.issuer,clientId:lmsInstallations.clientId,
      deploymentId:lmsInstallations.deploymentId,authorizationUrl:lmsInstallations.authorizationUrl,jwksUrl:lmsInstallations.jwksUrl,materialsService:lmsInstallations.materialsService})
      .from(lmsInstallations).where(and(eq(lmsInstallations.active,true),...(platform?[eq(lmsInstallations.issuer,platform.issuer),eq(lmsInstallations.clientId,platform.clientId)]:[])));
    if(!installations.length)return {installations,resources:[],linked:[]};
    const installationIds=installations.map(row=>row.id);
    const resourcesQuery=db.select({installationId:lmsResources.installationId,kind:lmsResources.kind,contextId:lmsResources.contextId,resourceLinkId:lmsResources.resourceLinkId,
      courseId:lmsResources.courseId,videoId:lmsResources.videoId,generation:lmsResources.generation,youtubeVideoId:lmsResources.youtubeVideoId,
      status:videos.status,videoOwner:videos.userId,sourceType:videos.sourceType,actualYoutubeVideoId:videos.youtubeVideoId,courseOwner:videoCourses.userId})
      .from(lmsResources).innerJoin(videoCourses,and(eq(videoCourses.id,lmsResources.courseId),eq(videoCourses.managedByLms,true),eq(videoCourses.nativeAccessDisabled,true)))
      .innerJoin(teachingConnections,and(eq(teachingConnections.provider,'moodle'),eq(teachingConnections.installationId,lmsResources.installationId),
        eq(teachingConnections.contextId,lmsResources.contextId),eq(teachingConnections.courseId,videoCourses.id),eq(teachingConnections.active,true),eq(teachingConnections.ownerUserId,videoCourses.userId)))
      .innerJoin(users,eq(users.id,videoCourses.userId)).leftJoin(videos,eq(videos.id,lmsResources.videoId))
      .where(and(eq(lmsResources.enabled,true),inArray(lmsResources.installationId,installationIds),activeLmsOwner()));
    const linkedQuery=db.select({installationId:teachingConnections.installationId,contextId:teachingConnections.contextId,courseId:teachingConnections.courseId,resourceLinkId:teachingConnections.resourceLinkId})
      .from(teachingConnections).innerJoin(videoCourses,and(eq(videoCourses.id,teachingConnections.courseId),eq(videoCourses.userId,teachingConnections.ownerUserId),eq(videoCourses.nativeAccessDisabled,false)))
      .innerJoin(users,eq(users.id,teachingConnections.ownerUserId))
      .where(and(eq(teachingConnections.provider,'moodle'),inArray(teachingConnections.installationId,installationIds),eq(teachingConnections.active,true),activeLmsOwner()));
    const resources=await resourcesQuery,linked=await linkedQuery;
    return {installations,resources,linked};
  })};
}
