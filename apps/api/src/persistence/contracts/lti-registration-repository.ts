import type { LtiRegistrationSnapshot, LtiPlatform } from '../../domain/lms/registration-snapshot';
export type { LtiInstallationRegistration, LtiResourceRegistration, LtiLinkedRegistration, LtiPlatform } from '../../domain/lms/registration-snapshot';
export interface LtiRegistrationRepository { snapshot(platform?: LtiPlatform): Promise<LtiRegistrationSnapshot>; }
