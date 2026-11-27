import { forbidden, unavailable } from '../../application/errors';
import type { PrivacyAssertionClaims } from '../../domain/lms/privacy';
import type { PrivacyAuthorizationRepository, PrivacyRegistration } from '../../persistence/contracts/privacy-authorization-repository';

export interface PrivacyAuthorizationDependencies {
  enabled: boolean;
  toolOrigin: string;
  hint(assertion: string): PrivacyAssertionClaims;
  verify(assertion: string, installation: PrivacyRegistration): Promise<PrivacyAssertionClaims>;
  repository(): Promise<PrivacyAuthorizationRepository>;
  digest(value: string): Promise<string>;
}
const denied = () => forbidden('Privacy request is unavailable.');

export async function authorizePrivacyRequest(deps: PrivacyAuthorizationDependencies, assertion: string) {
  if (!deps.enabled) throw unavailable('Privacy service is not enabled.', 'PRIVACY_UNAVAILABLE');
  let hint: PrivacyAssertionClaims;
  try { hint = deps.hint(assertion); } catch { throw denied(); }
  // Unverified identity only selects an approved stored registration, never a URL.
  const repository = await deps.repository();
  const installation = await repository.findInstallation({ issuer: hint.iss, clientId: hint.sub, deploymentId: hint.deploymentId });
  if (!installation) throw denied();
  let verified: PrivacyAssertionClaims;
  try {
    verified = await deps.verify(assertion, installation);
    if (verified.sub !== installation.clientId || verified.aud !== deps.toolOrigin + '/api/lms/privacy'
      || verified.deploymentId !== installation.deploymentId) throw denied();
  } catch { throw denied(); }
  const nonce = await deps.digest(JSON.stringify(['lti-privacy-jti-v1', installation.id, verified.jti]));
  if (!await repository.consumeNonce(installation, nonce, verified.request.action, new Date((verified.exp + 60) * 1000))) throw denied();
  return { installation, request: verified.request };
}
