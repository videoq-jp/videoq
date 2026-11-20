import { registrationFingerprintInput } from '../../application/lti-authorization';
import type { LtiRegistration } from '../../application/lti-registration';
import { digest } from './store';
export type { LearningAuthorization } from '../../application/lti-authorization';
export { learningFeatures } from '../../application/lti-authorization';

export function registrationFingerprint(reg: LtiRegistration) {
  return digest(registrationFingerprintInput(reg));
}
