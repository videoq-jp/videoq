import type { z } from "zod";
import type { LtiRegistration } from "./config";
import type { CourseAccess } from "./course-access";
import type { sessionRecord } from "./protocol";
import { digest } from "./store";
import type { getCourseWithMembers } from "../../repositories/chat-repository";

export type LearningAuthorization = {
  grant: z.infer<typeof sessionRecord>;
  reg: LtiRegistration;
  sessionHash: string;
  current?: CourseAccess;
  course?: NonNullable<Awaited<ReturnType<typeof getCourseWithMembers>>>;
};

export function registrationFingerprint(reg: LtiRegistration) {
  return digest(JSON.stringify(reg.id.startsWith("db:") ? { ...reg, resources: [] } : reg));
}

export function learningFeatures(reg: LtiRegistration, grant?: Pick<LearningAuthorization['grant'], 'courseId' | 'contextId' | 'resourceLinkId'>) {
  const courseAccess = Boolean(reg.courseAccess || reg.materialsService || reg.id.startsWith("classroom:"));
  const linked = grant && reg.resources.some(item => item.kind === 'linked' && item.courseId === grant.courseId
    && item.contextId === grant.contextId && item.resourceLinkId === grant.resourceLinkId);
  const managed = reg.id.startsWith("db:") && !linked;
  return { transcripts: courseAccess, qa: courseAccess, conversations: courseAccess,
    management: managed, tags: managed, reports: managed };
}
