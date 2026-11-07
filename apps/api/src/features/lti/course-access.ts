import type { Bindings } from "../../types/bindings";
import { MaterialsClient, readServiceJson } from "./materials-client";
import { coursePermissionsSchema, deniedCoursePermissions, type CoursePermissions } from "./course-permissions";
import { z } from "zod";
import type { LtiRegistration } from "./config";
import type { sessionRecord } from "./protocol";

const accessResponse = z.object({
  contextId: z.string(),
  resourceLinkId: z.string(),
  permissions: coursePermissionsSchema.optional(),
  resources: z.array(z.object({ resourceLinkId: z.string(), lesson: z.string().regex(/^[a-z0-9_-]{1,64}$/), title: z.string().max(500) })).max(1000),
});
export type CourseVideo = { videoId: number; lesson: string; title: string };
export type CourseAccess = { videos: CourseVideo[]; permissions: CoursePermissions };
type CourseGrant = Pick<z.infer<typeof sessionRecord>, "deploymentId" | "contextId" | "resourceLinkId" | "courseId" | "accessProof" | "serviceSubject">;

/** Trusted administrator-configured origin only. Never follow redirects or cache permissions. */
export async function courseAccessContext(reg: LtiRegistration, grant: CourseGrant, env?: Bindings): Promise<CourseAccess | null> {
  if (reg.materialsService) {
    if (!env || !grant.serviceSubject || reg.deploymentId !== grant.deploymentId) throw new Error("LTI service access required");
    const client = new MaterialsClient(env, { clientId: reg.clientId, deploymentId: reg.deploymentId, materialsService: reg.materialsService });
    const access = await client.access(grant.contextId, grant.resourceLinkId, grant.serviceSubject);
    const allowed = access.resources.flatMap(item => {
      const binding = reg.resources.find(resource => resource.deploymentId === grant.deploymentId && resource.contextId === grant.contextId &&
        resource.courseId === grant.courseId && resource.resourceLinkId === item.resourceLinkId);
      return binding?.videoId ? [{ videoId: binding.videoId, lesson: item.lesson, title: item.title }] : [];
    });
    if (!allowed.length) throw new Error("LTI service access denied");
    return { videos: allowed.filter((item, index) => allowed.findIndex(video => video.videoId === item.videoId) === index),
      permissions: access.permissions ?? deniedCoursePermissions };
  }
  if (!reg.courseAccess) return null;
  if (!grant.accessProof) throw new Error("Moodle access proof required");
  const response = await fetch(reg.issuer.replace(/\/$/, "") + "/local/videoq/access.php", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...grant.accessProof, contextId: grant.contextId, resourceLinkId: grant.resourceLinkId, includePermissions: true }),
  });
  if (!response.ok) throw new Error("Moodle access denied");
  const access = accessResponse.parse(await readServiceJson(response, 512_000));
  if (access.contextId !== grant.contextId || access.resourceLinkId !== grant.resourceLinkId) throw new Error("Wrong Moodle course");
  const allowed = access.resources.flatMap(item => {
    const binding = reg.resources.find(resource => resource.deploymentId === grant.deploymentId && resource.contextId === grant.contextId && resource.courseId === grant.courseId && resource.resourceLinkId === item.resourceLinkId);
    return binding?.videoId ? [{ videoId: binding.videoId, lesson: item.lesson, title: item.title }] : [];
  });
  if (!allowed.length) throw new Error("Moodle access denied");
  return { videos: allowed.filter((video, index) => allowed.findIndex(item => item.videoId === video.videoId) === index),
    permissions: access.permissions ?? deniedCoursePermissions };
}

export async function courseAccess(reg: LtiRegistration, grant: CourseGrant, env?: Bindings): Promise<CourseVideo[] | null> {
  return (await courseAccessContext(reg, grant, env))?.videos ?? null;
}
