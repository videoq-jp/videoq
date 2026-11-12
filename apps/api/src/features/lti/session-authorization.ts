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

export function learningFeatures(reg: LtiRegistration) {
  const courseAccess = Boolean(reg.courseAccess || reg.materialsService);
  const managed = reg.id.startsWith("db:");
  return { transcripts: courseAccess, qa: courseAccess, conversations: courseAccess,
    management: managed, tags: managed, reports: managed };
}
