import { expect, it, vi } from 'vitest';
import { authorizeAttachment, classroomAccess, materialUri, type ClassroomAuthorizationDependencies } from '../src/features/classroom/authorization-service';
import type { ClassroomLaunch } from '../src/application/classroom';

const launch: ClassroomLaunch = { courseId: 'class', itemId: 'post', itemType: 'courseWork', attachmentId: 'attachment', view: 'teacher' };
const config = { toolOrigin: 'https://tool.example' };
function fixture() {
  return {
    clientId: 'client', config: () => config,
    account: vi.fn().mockResolvedValue({ subject: 'teacher', clientId: 'client', accessToken: 'access', expiresAt: 1 }),
    context: vi.fn().mockResolvedValue({ courseId: 'class', itemId: 'post', teacherContext: {} }),
    connection: vi.fn().mockResolvedValue({ id: 'material', provider: 'classroom', installationId: 'client', contextId: 'class',
      teacherSubject: 'teacher', resourceLinkId: null, ownerUserId: 'owner', courseId: 12, active: true, createdAt: '', courseTitle: 'Course' }),
    course: vi.fn().mockResolvedValue({ id: 12, userId: 'owner', memberVideoIds: [1] }),
    attachment: vi.fn().mockResolvedValue({ id: 'attachment', title: 'Material',
      studentViewUri: { uri: materialUri(config, 'student', 'material') }, teacherViewUri: { uri: materialUri(config, 'teacher', 'material') } }),
    summaries: vi.fn().mockResolvedValue([{ id: 1, title: 'Video' }]),
    fingerprint: vi.fn().mockResolvedValue('fingerprint'), digest: vi.fn().mockResolvedValue('hash'), subjectKey: vi.fn().mockResolvedValue('key'),
  } satisfies ClassroomAuthorizationDependencies;
}
it('rejects a mismatched account before querying the teaching connection or Classroom context', async () => {
  const deps = fixture();
  await expect(classroomAccess(deps, { ...launch, login_hint: 'other' }, 'token')).rejects.toThrow('Google account mismatch');
  expect(deps.context).not.toHaveBeenCalled(); expect(deps.connection).not.toHaveBeenCalled();
});
it('requires both attachment URIs to bind the same server-selected material', async () => {
  const deps = fixture();
  deps.attachment.mockResolvedValue({ id: 'attachment', title: 'Material', teacherViewUri: { uri: materialUri(config, 'teacher', 'material') }, studentViewUri: { uri: materialUri(config, 'student', 'other') } });
  await expect(authorizeAttachment(deps, launch, 'token', 'session')).rejects.toThrow('Attachment material is not connected');
  expect(deps.summaries).not.toHaveBeenCalled(); expect(deps.digest).not.toHaveBeenCalled();
});
it('rechecks course membership and rejects removal before exposing video metadata', async () => {
  const deps = fixture();
  deps.course.mockResolvedValueOnce({ id: 12, userId: 'owner', memberVideoIds: [1] }).mockResolvedValueOnce({ id: 12, userId: 'owner', memberVideoIds: [] });
  await expect(authorizeAttachment(deps, launch, 'token', 'session')).rejects.toThrow('Material was removed');
  expect(deps.summaries).not.toHaveBeenCalled();
});
it('distinguishes a co-teacher moderation grant from the owner history grant', async () => {
  const deps = fixture();
  deps.account.mockResolvedValue({ subject: 'co-teacher', clientId: 'client', accessToken: 'access', expiresAt: 1 });
  const result = await authorizeAttachment(deps, launch, 'token', 'session');
  expect(result.current).toMatchObject({ ownerHistory: false, permissions: { moderateQa: true, instructorQa: true, manageContent: false } });
  expect(result.grant).toMatchObject({ transport: 'classroom', scopeVideoIds: [1], roles: ['teacher'] });
});
