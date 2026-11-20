import { expect, it } from 'vitest';
import { mergeLtiRegistrations } from '../src/features/lti/registration-service';
import { ltiRegistrationSnapshotAllowed } from '../src/application/lti-registration';
import type { LtiRegistrationRepository, LtiResourceRegistration } from '../src/persistence/contracts/lti-registration-repository';

const installation = { id: 'school', ownerUserId: 'owner', issuer: 'https://school.test/path', clientId: 'client', deploymentId: 'deployment', authorizationUrl: 'https://school.test/auth', jwksUrl: 'https://school.test/keys', materialsService: null };
const resource: LtiResourceRegistration = { installationId: 'school', kind: 'youtube', contextId: 'context', resourceLinkId: 'video', courseId: 1, videoId: 2, generation: 3, youtubeVideoId: 'abcdefghijk', status: 'completed', videoOwner: 'owner', sourceType: 'youtube', actualYoutubeVideoId: 'abcdefghijk', courseOwner: 'owner' };
const options = { youtube: true, origin: () => 'https://school.test' };
const logic = { and: (left: boolean, right: boolean) => left && right };

it('keeps managed material isolation separate from linked-course eligibility', () => {
  const managed = { kind: 'managed' as const, enabledResource: true, managedCourse: true,
    nativeDisabled: true, activeConnection: true, activeOwner: true };
  expect(ltiRegistrationSnapshotAllowed(managed, logic)).toBe(true);
  for (const key of ['enabledResource', 'managedCourse', 'nativeDisabled', 'activeConnection', 'activeOwner']) {
    expect(ltiRegistrationSnapshotAllowed({ ...managed, [key]: false }, logic)).toBe(false);
  }
  const linked = { kind: 'linked' as const, nativeEnabled: true, activeConnection: true, activeOwner: true };
  expect(ltiRegistrationSnapshotAllowed(linked, logic)).toBe(true);
  for (const key of ['nativeEnabled', 'activeConnection', 'activeOwner']) {
    expect(ltiRegistrationSnapshotAllowed({ ...linked, [key]: false }, logic)).toBe(false);
  }
});
function snapshot(resources: LtiResourceRegistration[]): Awaited<ReturnType<LtiRegistrationRepository['snapshot']>> {
  return { installations: [installation], resources, linked: [] };
}

it('exposes only enabled, owner-matched and source-matched video bindings', () => {
  const valid = snapshot([resource, { ...resource, resourceLinkId: 'wrong-source', actualYoutubeVideoId: 'other' }, { ...resource, resourceLinkId: 'wrong-owner', videoOwner: 'other' }]);
  const [reg] = mergeLtiRegistrations([], valid, options);
  expect(reg.resources).toEqual([{ deploymentId: 'deployment', contextId: 'context', resourceLinkId: 'video', courseId: 1, videoId: 2, generation: 3, sourceGeneration: 3, learningAvailable: true }]);
  expect(mergeLtiRegistrations([], valid, { ...options, youtube: false })[0].resources).toEqual([]);
});

it('preserves course entry bindings even before a video exists', () => {
  const course = { ...resource, kind: 'course', videoId: null, status: null, videoOwner: null };
  expect(mergeLtiRegistrations([], snapshot([course]), options)[0].resources).toMatchObject([{ kind: 'course', courseId: 1, generation: 3, learningAvailable: false }]);
});

it('never merges static and database authorities for the same client', () => {
  const [configured] = mergeLtiRegistrations([], snapshot([]), options);
  expect(() => mergeLtiRegistrations([{ ...configured, id: 'static' }], snapshot([]), options)).toThrow('Duplicate static/database');
});
