import type { CourseAccessRegistration } from './lms-authority';

export type MaterialsService = { tokenEndpoint: string; endpoint: string };
export type LtiRegistration = {
  id: string; issuer: string; clientId: string; authorizationUrl: string; jwksUrl: string;
  courseAccess?: 'moodle'; materialsService?: MaterialsService; deploymentId?: string;
  frameOrigins: string[]; resources: CourseAccessRegistration['resources'];
};

export type ProvisionInstallation = {
  id: string; ownerUserId: string; name: string; issuer: string; clientId: string;
  deploymentId: string; authorizationUrl: string; jwksUrl: string;
};

type RegistrationSnapshotFacts<Predicate> = { activeConnection: Predicate; activeOwner: Predicate } & (
  | { kind: 'managed'; enabledResource: Predicate; managedCourse: Predicate; nativeDisabled: Predicate }
  | { kind: 'linked'; nativeEnabled: Predicate }
);

/** Managed LMS resources require native isolation. A teacher's linked course
 * keeps its established native-enabled rule, without imposing native share or
 * invitation eligibility (including the no-LMS-video restriction). */
export function ltiRegistrationSnapshotAllowed<Predicate>(facts: RegistrationSnapshotFacts<Predicate>,
  logic: { and(left: Predicate, right: Predicate): Predicate }): Predicate {
  const course = facts.kind === 'managed'
    ? logic.and(logic.and(facts.enabledResource, facts.managedCourse), facts.nativeDisabled)
    : facts.nativeEnabled;
  return logic.and(logic.and(facts.activeConnection, facts.activeOwner), course);
}
