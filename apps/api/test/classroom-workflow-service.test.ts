import { expect, it, vi } from 'vitest';
import { createClassroomWorkflowService, type ClassroomWorkflowDependencies } from '../src/features/classroom/workflow-service';
import { materialUri } from '../src/features/classroom/authorization-service';
import type { ClassroomLaunch } from '../src/application/classroom';

const launch: ClassroomLaunch = { courseId: 'class', itemId: 'post', itemType: 'courseWork', attachmentId: 'attachment', view: 'teacher' };
const config = { toolOrigin: 'https://tool.example' };
function fixture() {
  const deps = {
    authorization: { clientId: 'client', config: () => config,
      account: vi.fn().mockResolvedValue({ subject: 'teacher', clientId: 'client', accessToken: 'private-access', expiresAt: 1 }),
      context: vi.fn().mockResolvedValue({ courseId: 'class', itemId: 'post', teacherContext: {} }),
      connection: vi.fn().mockResolvedValue({ id: 'material', provider: 'classroom', installationId: 'client', contextId: 'class', teacherSubject: 'teacher', resourceLinkId: null, ownerUserId: 'owner', courseId: 12, active: true, createdAt: '', courseTitle: 'Course' }),
      course: vi.fn().mockResolvedValue({ id: 12, userId: 'owner', memberVideoIds: [1] }),
      attachment: vi.fn().mockResolvedValue({ id: 'attachment', title: 'Material', studentViewUri: { uri: materialUri(config, 'student', 'material') }, teacherViewUri: { uri: materialUri(config, 'teacher', 'material') } }),
      summaries: vi.fn().mockResolvedValue([{ id: 1, title: 'Video' }]), fingerprint: async () => 'fingerprint', digest: async () => 'subject-hash', subjectKey: async () => 'key',
    },
    newSecret: () => 'secret', digest: async () => 'session-hash', encrypt: vi.fn(async () => 'encrypted'), decrypt: vi.fn(async () => 'account-token'),
    loadSession: vi.fn<ClassroomWorkflowDependencies['loadSession']>().mockResolvedValue(null), saveSession: vi.fn<ClassroomWorkflowDependencies['saveSession']>().mockResolvedValue(),
    issueTeachingTicket: vi.fn().mockResolvedValue({ url: 'https://tool.example/connect' }), createAttachment: vi.fn().mockResolvedValue({ id: 'created' }),
    playback: vi.fn().mockResolvedValue(null), fileUrl: vi.fn().mockResolvedValue(null),
  } satisfies ClassroomWorkflowDependencies;
  return { deps, service: createClassroomWorkflowService(deps) };
}
it('does not attach a material whose current course membership shrank after the initial binding read', async () => {
  const { deps, service } = fixture();
  deps.authorization.course.mockResolvedValueOnce({ id: 12, userId: 'owner', memberVideoIds: [1, 2] }).mockResolvedValueOnce({ id: 12, userId: 'owner', memberVideoIds: [1] });
  await expect(service.attach({ ...launch, view: 'discovery', addOnToken: 'addon', attachmentId: undefined }, 'account', 'material')).rejects.toThrow('Material unavailable');
  expect(deps.createAttachment).not.toHaveBeenCalled();
});
it('rejects a learner before encrypting a teacher proof or issuing a connection ticket', async () => {
  const { deps, service } = fixture();
  deps.authorization.context.mockResolvedValue({ courseId: 'class', itemId: 'post', studentContext: {} });
  await expect(service.connectTeacher(launch, 'account')).rejects.toThrow('Teacher required');
  expect(deps.encrypt).not.toHaveBeenCalled(); expect(deps.issueTeachingTicket).not.toHaveBeenCalled();
});
it('encrypts a session-bound account envelope and retains accumulated scope for shrinkage checks', async () => {
  const { deps, service } = fixture();
  const response = await service.createSession(launch, 'account-token', await service.prepareSession());
  expect(response).toMatchObject({ token: 'secret', learningAvailable: true });
  expect(deps.encrypt).toHaveBeenCalledWith('account-token', 'classroom-session:session-hash');
  const saved = deps.saveSession.mock.calls[0][1];
  expect(deps.saveSession.mock.calls[0][2]).toBe(3600);
  deps.loadSession.mockResolvedValue({ ...saved, scopeVideoIds: [1, 2] });
  const authorized = await service.authorize('secret');
  expect(authorized).toMatchObject({ access: { grant: { scopeVideoIds: [1, 2] }, current: { videos: [{ videoId: 1 }] } } });
  deps.loadSession.mockResolvedValue({ ...saved, subjectHash: 'different-subject' });
  expect(await service.authorize('secret')).toEqual({ failure: 'forbidden' });
});
