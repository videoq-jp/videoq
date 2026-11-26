import { expect, it, vi } from 'vitest';
import { authorizeLtiSession, exchangeLtiLogin, initiateLtiLogin, type LtiSessionDependencies } from '../src/features/lti/session-service';
import type { LtiRegistration } from '../src/domain/lms/lti-registration';
import type { LearningGrant } from '../src/domain/lms/native-learning';

const reg: LtiRegistration = { id: 'school', issuer: 'https://school.test', clientId: 'client', authorizationUrl: 'https://school.test/auth', jwksUrl: 'https://school.test/keys', frameOrigins: ['https://school.test'],
  resources: [{ deploymentId: 'dep', contextId: 'ctx', resourceLinkId: 'res', courseId: 1, videoId: 2, generation: 3 }] };
const grant: LearningGrant = { registrationId: 'school', registrationHash: 'fingerprint', deploymentId: 'dep', contextId: 'ctx', resourceLinkId: 'res', courseId: 1, videoId: 2, resourceGeneration: 3, locale: 'en', roles: [], subjectHash: 'b'.repeat(64) };
function fixture() {
  return {
    loadLogin: vi.fn().mockResolvedValue({ registrationId: 'school', nonce: 'nonce', browserHash: 'hash:browser', target: 'https://tool.test/launch' }),
    loadSession: vi.fn().mockResolvedValue(grant), saveLogin: vi.fn(), saveSession: vi.fn(), consumeLogin: vi.fn().mockResolvedValue(true),
    newSecret: vi.fn().mockReturnValue('secret'), digest: vi.fn(async (value: string) => 'hash:' + value), fingerprint: vi.fn().mockResolvedValue('fingerprint'),
    verify: vi.fn().mockResolvedValue({ locale: 'en', subject: 'learner', deploymentId: 'dep', contextId: 'ctx', resourceLinkId: 'res', roles: [], courseId: 1, videoId: 2, resourceGeneration: 3 }),
    course: vi.fn().mockResolvedValue({ id: 1, userId: 'owner', memberVideoIds: [2] }), access: vi.fn().mockResolvedValue(null),
  } satisfies LtiSessionDependencies;
}
it('does not issue login secrets for ambiguous authorities or another target', async () => {
  const deps = fixture();
  const input = { issuer: reg.issuer, loginHint: 'learner', target: 'https://tool.test/launch', locale: 'en' as const };
  await expect(initiateLtiLogin(deps, [reg, { ...reg, id: 'duplicate' }], input.target, input)).resolves.toBeNull();
  await expect(initiateLtiLogin(deps, [reg], input.target, { ...input, target: 'https://attacker.test' })).resolves.toBeNull();
  expect(deps.newSecret).not.toHaveBeenCalled();
  expect(deps.saveLogin).not.toHaveBeenCalled();
});
it('does not consume login state or store a session when live course access is revoked', async () => {
  const deps = fixture();
  deps.access.mockRejectedValue(new Error('revoked'));
  await expect(exchangeLtiLogin(deps, [reg], { state: 'state', browserSecret: 'browser', idToken: 'jwt' })).resolves.toEqual({ ok: false, failure: 'forbidden' });
  expect(deps.consumeLogin).not.toHaveBeenCalled();
  expect(deps.saveSession).not.toHaveBeenCalled();
});
it('rejects replay and immediately revoked resource generations', async () => {
  const deps = fixture();
  deps.consumeLogin.mockResolvedValue(false);
  await expect(exchangeLtiLogin(deps, [reg], { state: 'state', browserSecret: 'browser', idToken: 'jwt' })).resolves.toEqual({ ok: false, failure: 'unauthorized' });
  expect(deps.saveSession).not.toHaveBeenCalled();
  await expect(authorizeLtiSession(deps, [{ ...reg, resources: [{ ...reg.resources[0], generation: 4 }] }], 'token')).resolves.toEqual({ ok: false, failure: 'forbidden' });
});
