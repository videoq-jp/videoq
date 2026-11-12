import type { Bindings } from '../../types/bindings';
import { MaterialsClient } from './connector-client';
import type { CourseAuthorityResponse, MaterialsService } from './contracts';
import { resolveMoodleAuthority } from './providers/moodle/authority';
import { defaultLegacyAuthority } from './provider-registry';

// Provider registration is separate from normalized learning authorization.
type Registration = { issuer: string; clientId: string; deploymentId?: string;
  materialsService?: MaterialsService; courseAccess?: typeof defaultLegacyAuthority };
type Request = { deploymentId: string; contextId: string; resourceLinkId: string;
  serviceSubject?: string; accessProof?: { token: string; subject: string } };

export function hasCourseAuthority(reg: Registration) {
  return Boolean(reg.materialsService || reg.courseAccess);
}

/** A connector supplies current capabilities; VideoQ still intersects its own bindings. */
export async function requestCourseAuthority(reg: Registration, request: Request, env?: Bindings): Promise<CourseAuthorityResponse | null> {
  if (reg.materialsService) {
    if (!env || !request.serviceSubject || reg.deploymentId !== request.deploymentId) throw new Error('LMS service access required');
    return new MaterialsClient(env, { clientId: reg.clientId, deploymentId: reg.deploymentId, materialsService: reg.materialsService })
      .access(request.contextId, request.resourceLinkId, request.serviceSubject);
  }
  if (!reg.courseAccess) return null;
  const adapters = { [defaultLegacyAuthority]: resolveMoodleAuthority };
  return adapters[reg.courseAccess](reg.issuer, request);
}
