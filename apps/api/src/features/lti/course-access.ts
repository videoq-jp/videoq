import type { Bindings } from "../../types/bindings";
import { MaterialsClient, readServiceJson, materialManagementSchema, courseEntryAccessSchema } from "./materials-client";
import { coursePermissionsSchema, deniedCoursePermissions, type CoursePermissions } from "./course-permissions";
import { z } from "zod";
import type { LtiRegistration } from "./config";
import type { sessionRecord } from "./protocol";

const accessResponse = z.object({
  contextId: z.string(),
  resourceLinkId: z.string(),
  permissions: coursePermissionsSchema.optional(),
  courseEntry: courseEntryAccessSchema.optional(),
  resources: z.array(z.object({ resourceLinkId: z.string(), lesson: z.string().regex(/^[a-z0-9_-]{1,64}$/), title: z.string().max(500),
    generation: z.number().int().positive().safe().optional(),
    learning: z.boolean().optional(), management: materialManagementSchema.optional() })).max(1000),
});
export type CourseVideo = { videoId: number; lesson: string; title: string; management?: z.infer<typeof materialManagementSchema> };
export type CourseAccess = { videos: CourseVideo[]; managementVideos?: CourseVideo[]; materialOrder?: number[]; permissions: CoursePermissions };
type CourseGrant = Pick<z.infer<typeof sessionRecord>, "deploymentId" | "contextId" | "resourceLinkId" | "courseId" | "accessProof" | "serviceSubject" | 'resourceGeneration'>;

function boundAccess(reg: LtiRegistration, grant: CourseGrant, access: z.infer<typeof accessResponse>): CourseAccess {
  const permissions = access.permissions ?? deniedCoursePermissions;
  const entry = reg.resources.find(resource => resource.deploymentId === grant.deploymentId && resource.contextId === grant.contextId
    && resource.courseId === grant.courseId && resource.resourceLinkId === grant.resourceLinkId);
  const courseEntry = reg.id.startsWith('db:') && entry?.kind === 'course' && entry.videoId === undefined
    && entry.generation !== undefined && entry.generation === grant.resourceGeneration
    && access.courseEntry?.generation === entry.generation;
  // An anchor must always be freshly confirmed, including when videos exist.
  if (entry?.kind === 'course' && !courseEntry) throw new Error('Moodle access denied');
  const allowed: CourseVideo[] = [], managementVideos: CourseVideo[] = [], materialOrder: number[] = [];
  for (const item of access.resources) {
    const binding = reg.resources.find(resource => resource.deploymentId === grant.deploymentId && resource.contextId === grant.contextId
      && resource.courseId === grant.courseId && resource.resourceLinkId === item.resourceLinkId);
    if (!binding?.videoId) continue;
    if (item.generation!==undefined && binding.generation!==undefined && item.generation!==binding.generation) continue;
    const video: CourseVideo = { videoId: binding.videoId, lesson: item.lesson, title: item.title };
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
  if (!allowed.length && !managementVideos.length && !courseEntry) throw new Error('Moodle access denied');
  return { videos: unique(allowed), ...(managementVideos.length ? { managementVideos: unique(managementVideos) } : {}),
    materialOrder: [...new Set(materialOrder)], permissions };
}

/** Trusted administrator-configured origin only. Never follow redirects or cache permissions. */
export async function courseAccessContext(reg: LtiRegistration, grant: CourseGrant, env?: Bindings): Promise<CourseAccess | null> {
  if (reg.materialsService) {
    if (!env || !grant.serviceSubject || reg.deploymentId !== grant.deploymentId) throw new Error("LTI service access required");
    const client = new MaterialsClient(env, { clientId: reg.clientId, deploymentId: reg.deploymentId, materialsService: reg.materialsService });
    const access = await client.access(grant.contextId, grant.resourceLinkId, grant.serviceSubject);
    return boundAccess(reg, grant, access);
  }
  if (!reg.courseAccess) return null;
  if (!grant.accessProof) throw new Error("Moodle access proof required");
  const response = await fetch(reg.issuer.replace(/\/$/, "") + "/local/videoq/access.php", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...grant.accessProof, contextId: grant.contextId, resourceLinkId: grant.resourceLinkId,
      includePermissions: true, includeContentManagement: true, includeCourseEntries: true, includeReports: true }),
  });
  if (!response.ok) throw new Error("Moodle access denied");
  const access = accessResponse.parse(await readServiceJson(response, 512_000));
  if (access.contextId !== grant.contextId || access.resourceLinkId !== grant.resourceLinkId) throw new Error("Wrong Moodle course");
  return boundAccess(reg, grant, access);
}

export async function courseAccess(reg: LtiRegistration, grant: CourseGrant, env?: Bindings): Promise<CourseVideo[] | null> {
  return (await courseAccessContext(reg, grant, env))?.videos ?? null;
}
