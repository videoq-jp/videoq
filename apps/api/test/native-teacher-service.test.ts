import { expect, it, vi } from 'vitest';
import type { LtiRegistration } from '../src/application/lti-registration';
import { bootstrapNativeTeacher, type NativeTeacherDependencies } from '../src/features/lms/native-teacher-service';

const registration: LtiRegistration = {
  id: 'db:school', issuer: 'https://school.example', clientId: 'client',
  authorizationUrl: 'https://school.example/auth', jwksUrl: 'https://school.example/keys',
  deploymentId: 'deployment', materialsService: { tokenEndpoint: 'https://school.example/token', endpoint: 'https://school.example/materials' },
  resources: [], frameOrigins: [],
};
const claims = { contextId: 'course /1', resourceLinkId: 'entry', subject: 'teacher', jti: 'nonce', exp: 1000 };
function dependencies() {
  return {
    access: vi.fn<NativeTeacherDependencies['access']>().mockResolvedValue({ permissions: { manageContent: true } }),
    digest: vi.fn(async () => 'digest'), consumeNonce: vi.fn(async () => true),
    issueTicket: vi.fn(async () => ({ url: 'https://videoq.example/connect' })),
  };
}

it.each([
  { ...registration, id: 'configured:school' },
  { ...registration, materialsService: undefined },
  { ...registration, deploymentId: undefined },
])('rejects unsupported bootstrap registrations before remote access', async reg => {
  const deps = dependencies();
  expect(await bootstrapNativeTeacher(deps, reg, claims)).toBeNull();
  expect(deps.access).not.toHaveBeenCalled();
  expect(deps.consumeNonce).not.toHaveBeenCalled();
  expect(deps.issueTicket).not.toHaveBeenCalled();
});

it('requires fresh manageContent authority before hashing or consuming a nonce', async () => {
  const deps = dependencies();
  deps.access.mockResolvedValue({ permissions: { manageContent: false } });
  expect(await bootstrapNativeTeacher(deps, registration, claims)).toBeNull();
  expect(deps.digest).not.toHaveBeenCalled();
  expect(deps.consumeNonce).not.toHaveBeenCalled();
  expect(deps.issueTicket).not.toHaveBeenCalled();
});

it('treats omitted permissions as denied without consuming the assertion', async () => {
  const deps = dependencies();
  deps.access.mockResolvedValue({});
  expect(await bootstrapNativeTeacher(deps, registration, claims)).toBeNull();
  expect(deps.consumeNonce).not.toHaveBeenCalled();
  expect(deps.issueTicket).not.toHaveBeenCalled();
});

it('uses the registration-bound nonce and expiry grace, rejecting replay without issuing a ticket', async () => {
  const deps = dependencies();
  deps.consumeNonce.mockResolvedValue(false);
  expect(await bootstrapNativeTeacher(deps, registration, claims)).toBeNull();
  expect(deps.digest).toHaveBeenCalledExactlyOnceWith(JSON.stringify(['teaching-link', registration.id, claims.jti]));
  expect(deps.consumeNonce).toHaveBeenCalledExactlyOnceWith('digest', new Date(1060000));
  expect(deps.issueTicket).not.toHaveBeenCalled();
});

it('issues the existing ticket payload only after nonce consumption succeeds', async () => {
  const deps = dependencies();
  deps.consumeNonce.mockImplementation(async () => {
    expect(deps.issueTicket).not.toHaveBeenCalled();
    return true;
  });
  expect(await bootstrapNativeTeacher(deps, registration, claims)).toEqual({ url: 'https://videoq.example/connect' });
  expect(deps.issueTicket).toHaveBeenCalledExactlyOnceWith({
    provider: 'moodle', installationId: 'school', contextId: claims.contextId,
    teacherSubject: 'teacher', teacherName: 'Moodle user teacher', title: 'Moodle course /1',
    resourceLinkId: 'entry', returnUrl: 'https://school.example/course/view.php?id=course%20%2F1',
  });
});

it('preserves supplied display names and title without replacing opaque subjects', async () => {
  const deps = dependencies();
  await bootstrapNativeTeacher(deps, registration, { ...claims, author: { name: '先生', email: 'teacher@example.com' } }, '授業');
  expect(deps.issueTicket).toHaveBeenCalledWith(expect.objectContaining({ teacherName: '先生', title: '授業', teacherSubject: 'teacher' }));
});

it.each(['access', 'consumeNonce', 'issueTicket'] as const)('propagates %s failure without repeating external effects', async stage => {
  const deps = dependencies(), failure = new Error(stage + ' unavailable');
  deps[stage].mockRejectedValue(failure);
  await expect(bootstrapNativeTeacher(deps, registration, claims)).rejects.toBe(failure);
  expect(deps.access).toHaveBeenCalledOnce();
  expect(deps.consumeNonce).toHaveBeenCalledTimes(stage === 'access' ? 0 : 1);
  expect(deps.issueTicket).toHaveBeenCalledTimes(stage === 'issueTicket' ? 1 : 0);
});

it('propagates provider failure without consuming the one-time bootstrap', async () => {
  const deps = dependencies(), failure = new Error('authority unavailable');
  deps.access.mockRejectedValue(failure);
  await expect(bootstrapNativeTeacher(deps, registration, claims)).rejects.toBe(failure);
  expect(deps.consumeNonce).not.toHaveBeenCalled();
});
