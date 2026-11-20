import { deniedCoursePermissions, type CourseAccess, type CourseAccessRegistration, type CourseAuthorityResponse, type CourseGrant, type CourseVideo } from '../../application/lms-authority';
import type { LinkedLearningCourse } from '../../persistence/contracts/linked-learning-repository';

export interface CourseAccessDependencies {
  requestAuthority(grant: CourseGrant): Promise<CourseAuthorityResponse | null>;
  findLinkedCourse?: (installationId: string, contextId: string) => Promise<LinkedLearningCourse | null>;
}

function boundAccess(reg: CourseAccessRegistration, grant: CourseGrant, access: CourseAuthorityResponse): CourseAccess {
  const permissions = access.permissions ?? deniedCoursePermissions;
  const entry = reg.resources.find(resource => resource.deploymentId === grant.deploymentId && resource.contextId === grant.contextId
    && resource.courseId === grant.courseId && resource.resourceLinkId === grant.resourceLinkId);
  const courseEntry = reg.id.startsWith('db:') && entry?.kind === 'course' && entry.videoId === undefined
    && entry.generation !== undefined && entry.generation === grant.resourceGeneration
    && access.courseEntry?.generation === entry.generation;
  // An anchor must always be freshly confirmed, including when videos exist.
  if (entry?.kind === 'course' && !courseEntry) throw new Error('LMS access denied');
  const allowed: CourseVideo[] = [], managementVideos: CourseVideo[] = [], materialOrder: number[] = [];
  for (const item of access.resources) {
    const binding = reg.resources.find(resource => resource.deploymentId === grant.deploymentId && resource.contextId === grant.contextId
      && resource.courseId === grant.courseId && resource.resourceLinkId === item.resourceLinkId);
    if (!binding?.videoId) continue;
    if (item.generation!==undefined && binding.generation!==undefined && item.generation!==binding.generation) continue;
    if (binding.sourceGeneration !== undefined && item.generation !== binding.sourceGeneration) continue;
    const video: CourseVideo = { videoId: binding.videoId, lesson: item.lesson, title: item.title };
    if (binding.sourceGeneration !== undefined && binding.sourceGeneration === binding.generation) {
      video.sourceGeneration = binding.sourceGeneration;
    }
    const management = permissions.manageContent && reg.id.startsWith('db:') && item.management
      && item.management.generation===binding.generation;
    const learning = item.learning !== false && binding.learningAvailable !== false;
    if (management) {
      video.management = item.management;
      managementVideos.push(video);
    }
    if (learning) allowed.push(video);
    if (learning || management) materialOrder.push(video.videoId);
  }
  const unique = (videos: CourseVideo[]) => videos.filter((item, index) => videos.findIndex(video => video.videoId === item.videoId) === index);
  if (!allowed.length && !managementVideos.length && !courseEntry) throw new Error('LMS access denied');
  return { videos: unique(allowed), ...(managementVideos.length ? { managementVideos: unique(managementVideos) } : {}),
    materialOrder: [...new Set(materialOrder)], permissions };
}

/** Trusted administrator-configured origin only. Never follow redirects or cache permissions. */
export async function resolveCourseAccess(reg: CourseAccessRegistration, grant: CourseGrant, deps: CourseAccessDependencies): Promise<CourseAccess | null> {
  const access = await deps.requestAuthority(grant);
  const linked = reg.resources.find(item => item.kind === 'linked' && item.deploymentId === grant.deploymentId
    && item.contextId === grant.contextId && item.resourceLinkId === grant.resourceLinkId && item.courseId === grant.courseId);
  if (linked) {
    if (!deps.findLinkedCourse || !access?.courseEntry || !reg.id.startsWith('db:')) throw new Error('LMS access denied');
    const connection = await deps.findLinkedCourse(reg.id.slice(3), grant.contextId);
    if (!connection || connection.courseId !== grant.courseId || connection.resourceLinkId !== grant.resourceLinkId) throw new Error('LMS access denied');
    return { courseTitle: connection.courseTitle,
      course: { id: connection.courseId, userId: connection.ownerUserId, memberVideoIds: connection.videos.map(video => video.videoId) },
      ownerHistory: access.permissions?.manageContent === true && grant.serviceSubject === connection.teacherSubject,
      videos: connection.videos, permissions: { ...(access.permissions ?? deniedCoursePermissions), manageContent: false, viewReports: false } };
  }
  return access ? boundAccess(reg, grant, access) : null;
}
