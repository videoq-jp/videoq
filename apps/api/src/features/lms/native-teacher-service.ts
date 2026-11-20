import type { LtiRegistration, MaterialsService } from '../../application/lti-registration';
import type { NativeLearningClaims } from '../../application/native-learning';
import type { TeachingTicket } from '../../application/teaching';

type TeacherClaims = Pick<NativeLearningClaims, 'contextId' | 'resourceLinkId' | 'subject' | 'author' | 'jti' | 'exp'>;
export interface NativeTeacherDependencies {
  access(registration: LtiRegistration & { deploymentId: string; materialsService: MaterialsService }, claims: TeacherClaims): Promise<{ permissions?: { manageContent?: boolean } }>;
  digest(value: string): Promise<string>;
  consumeNonce(id: string, expiresAt: Date): Promise<boolean>;
  issueTicket(input: TeachingTicket): Promise<{ url: string }>;
}

/** The caller verifies the endpoint/body-bound assertion before invoking this workflow. */
export async function bootstrapNativeTeacher(deps: NativeTeacherDependencies,
  reg: LtiRegistration, claims: TeacherClaims, title?: string): Promise<{ url: string } | null> {
  if (!reg.id.startsWith('db:') || !reg.materialsService || !reg.deploymentId) return null;
  const access = await deps.access({ ...reg, deploymentId: reg.deploymentId, materialsService: reg.materialsService }, claims);
  if (!access.permissions?.manageContent) return null;
  const nonce = await deps.digest(JSON.stringify(['teaching-link', reg.id, claims.jti]));
  if (!await deps.consumeNonce(nonce, new Date((claims.exp + 60) * 1000))) return null;
  return deps.issueTicket({
    provider: 'moodle', installationId: reg.id.slice(3), contextId: claims.contextId,
    teacherSubject: claims.subject, teacherName: claims.author?.name || 'Moodle user ' + claims.subject,
    title: title || 'Moodle ' + claims.contextId, resourceLinkId: claims.resourceLinkId,
    returnUrl: reg.issuer + '/course/view.php?id=' + encodeURIComponent(claims.contextId),
  });
}
