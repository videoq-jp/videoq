import { registrationFingerprintInput } from '../../domain/lms/learning-features';
import type { LtiRegistration } from '../../domain/lms/lti-registration';
import { digest } from './store';
export type { LearningAuthorization } from '../../application/lti-authorization';
export { learningFeatures } from '../../domain/lms/learning-features';

export function registrationFingerprint(reg: LtiRegistration) {
  return digest(registrationFingerprintInput(reg));
}
