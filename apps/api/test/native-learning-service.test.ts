import { describe, expect, it, vi } from 'vitest';
import { createNativeLearningService } from '../src/features/lms/native-learning-service';
import type { NativeLearningAccess, NativeLearningClaims, NativeLearningRegistration, NativeSessionInput } from '../src/domain/lms/native-learning';

const reg: NativeLearningRegistration = {
  id: 'school', issuer: 'https://school.example', clientId: 'client', materialsService: {},
  resources: [{ deploymentId: 'd', contextId: 'c', resourceLinkId: 'r', courseId: 12, generation: 4 }],
};
const claims: NativeLearningClaims = { deploymentId: 'd', contextId: 'c', resourceLinkId: 'r',
  subject: 'learner', sessionId: 'session', sessionExpiresAt: 3600, exp: 60, jti: 'nonce', locale: 'ja' };
function setup() {
  const deps = {
    digest: vi.fn(async (text: string) => text),
    fingerprint: vi.fn(async (_reg: NativeLearningRegistration) => 'fingerprint'),
    access: vi.fn<() => Promise<NativeLearningAccess | null>>().mockResolvedValue({ videos: [{ videoId: 3 }, { videoId: 1 }], managementVideos: [{ videoId: 8 }] }),
    loadCourse: vi.fn(async (_courseId: number, _ids: number[]) => ({ id: 12, userId: 'owner', memberVideoIds: [1, 3, 8] })),
    ensureSession: vi.fn(async (_input: NativeSessionInput) => {}),
  };
  return { deps, authorize: createNativeLearningService(deps) };
}

describe('native learning authorization workflow', () => {
  it('derives scope from fresh authority and consumes the request with server identity', async () => {
    const { deps, authorize } = setup();
    const result = await authorize(reg, { ...claims, author: { name: 'Learner', email: '' } });
    expect(deps.loadCourse).toHaveBeenCalledWith(12, [3, 1, 8]);
    expect(result.grant).toMatchObject({ courseId: 12, resourceGeneration: 4, serviceSubject: 'learner',
      scopeVideoIds: [1, 3], roles: [], registrationHash: 'fingerprint', moodleAuthor: { username: 'Learner' } });
    expect(deps.ensureSession).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'owner', grant: result.grant,
      nonceExpiresAt: new Date(120000), expiresAt: new Date(3600000) }));
    // Management-only videos can help load the course, but never widen learning scope.
    expect(result.grant.scopeVideoIds).not.toContain(8);
  });
  it('rejects missing bindings or proof before calling the authority provider', async () => {
    const { deps, authorize } = setup();
    await expect(authorize(reg, { ...claims, contextId: 'another-course' })).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(authorize({ ...reg, materialsService: undefined }, claims)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(deps.access).not.toHaveBeenCalled();
    expect(deps.ensureSession).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable or revoked authority, without creating a session', async () => {
    const { deps, authorize } = setup();
    deps.access.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('revoked'));
    for (let i = 0; i < 2; i++) {
      await expect(authorize(reg, claims)).rejects.toMatchObject({ kind: 'forbidden' });
    }
    expect(deps.loadCourse).not.toHaveBeenCalled();
    expect(deps.ensureSession).not.toHaveBeenCalled();
  });
  it('reuses a freshly authorized course and propagates atomic session rejection', async () => {
    const { deps, authorize } = setup();
    deps.access.mockResolvedValue({ videos: [], course: { id: 12, userId: 'owner', memberVideoIds: [] } });
    deps.ensureSession.mockRejectedValueOnce(new Error('replayed request'));
    await expect(authorize(reg, claims)).rejects.toThrow('replayed request');
    expect(deps.loadCourse).not.toHaveBeenCalled();
  });
  it('uses the signed access proof for legacy authority', async () => {
    const { authorize } = setup();
    const result = await authorize({ ...reg, materialsService: undefined }, { ...claims, accessProof: 'proof' });
    expect(result.grant.accessProof).toEqual({ token: 'proof', subject: 'learner' });
    expect(result.grant.serviceSubject).toBeUndefined();
  });
});
