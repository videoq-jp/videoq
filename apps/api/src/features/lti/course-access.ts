import type { Bindings } from "../../types/bindings";
import { MaterialsClient } from "./materials-client";
import { z } from "zod";
import type { LtiRegistration } from "./config";
import type { sessionRecord } from "./protocol";

const accessResponse = z.object({
  contextId: z.string(),
  resourceLinkId: z.string(),
  resources: z.array(z.object({ resourceLinkId: z.string(), lesson: z.string().regex(/^[a-z0-9_-]{1,64}$/), title: z.string().max(500) })).max(1000),
});
export type CourseVideo = { videoId: number; lesson: string; title: string };

/** Trusted administrator-configured origin only. Never follow redirects or cache permissions. */
export async function courseAccess(reg: LtiRegistration, grant: Pick<z.infer<typeof sessionRecord>, "deploymentId" | "contextId" | "resourceLinkId" | "courseId" | "accessProof" | "serviceSubject">, env?: Bindings): Promise<CourseVideo[] | null> {
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
    return allowed.filter((item, index) => allowed.findIndex(video => video.videoId === item.videoId) === index);
  }
  if (!reg.courseAccess) return null;
  if (!grant.accessProof) throw new Error("Moodle access proof required");
  const response = await fetch(reg.issuer.replace(/\/$/, "") + "/local/videoq/access.php", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...grant.accessProof, contextId: grant.contextId, resourceLinkId: grant.resourceLinkId }),
  });
  if (!response.ok) throw new Error("Moodle access denied");
  const text = await response.text();
  if (text.length > 512_000) throw new Error("Invalid Moodle access response");
  const access = accessResponse.parse(JSON.parse(text));
  if (access.contextId !== grant.contextId || access.resourceLinkId !== grant.resourceLinkId) throw new Error("Wrong Moodle course");
  const allowed = access.resources.flatMap(item => {
    const binding = reg.resources.find(resource => resource.deploymentId === grant.deploymentId && resource.contextId === grant.contextId && resource.courseId === grant.courseId && resource.resourceLinkId === item.resourceLinkId);
    return binding?.videoId ? [{ videoId: binding.videoId, lesson: item.lesson, title: item.title }] : [];
  });
  if (!allowed.length) throw new Error("Moodle access denied");
  return allowed.filter((video, index) => allowed.findIndex(item => item.videoId === video.videoId) === index);
}
