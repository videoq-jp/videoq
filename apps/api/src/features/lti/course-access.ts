import type { Bindings } from "../../types/bindings";
import { requestCourseAuthority } from '../lms/authority';
import type { CourseAuthorityResponse } from '../lms/contracts';
import { materialManagementSchema } from '../lms/contracts';
import { deniedCoursePermissions, type CoursePermissions } from "./course-permissions";
import type { z } from "zod";
import type { LtiRegistration } from "./config";
import type { sessionRecord } from "./protocol";

export type CourseVideo = { videoId: number; lesson: string; title: string; sourceGeneration?: number;
  management?: z.infer<typeof materialManagementSchema> };
export type CourseAccess = { videos: CourseVideo[]; managementVideos?: CourseVideo[]; materialOrder?: number[]; permissions: CoursePermissions };
type CourseGrant = Pick<z.infer<typeof sessionRecord>, "deploymentId" | "contextId" | "resourceLinkId" | "courseId" | "accessProof" | "serviceSubject" | 'resourceGeneration'>;

function boundAccess(reg: LtiRegistration, grant: CourseGrant, access: CourseAuthorityResponse): CourseAccess {
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
export async function courseAccessContext(reg: LtiRegistration, grant: CourseGrant, env?: Bindings): Promise<CourseAccess | null> {
  const access = await requestCourseAuthority(reg, grant, env);
  return access ? boundAccess(reg, grant, access) : null;
}

export async function courseAccess(reg: LtiRegistration, grant: CourseGrant, env?: Bindings): Promise<CourseVideo[] | null> {
  return (await courseAccessContext(reg, grant, env))?.videos ?? null;
}
