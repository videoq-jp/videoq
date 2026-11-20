import { expect, it, vi } from 'vitest';
import { learningConversationScope, learningConversationTurns, learningManagedMaterialScope, learningReportScope, learningTagScope, canUseLearningQa, type LearningOperationAccess } from '../src/features/lti/operation-policy';
import { deniedCoursePermissions } from '../src/application/lms-authority';
import { executeLearningMaterialOperation } from '../src/features/material-management/service';

const access: LearningOperationAccess = {
  sessionHash: 'session', course: { userId: 'owner', memberVideoIds: [1] },
  grant: { registrationId: 'db:school', registrationHash: 'hash', deploymentId: 'deployment', contextId: 'context',
    resourceLinkId: 'resource', locale: 'ja', courseId: 12, subjectHash: 'subject', roles: [] },
  reg: { id: 'db:school', issuer: 'issuer', clientId: 'client', authorizationUrl: 'authorize', jwksUrl: 'keys', frameOrigins: [],
    resources: [1, 2].map(videoId => ({ videoId, courseId: 12, deploymentId: 'deployment', contextId: 'context', resourceLinkId: `resource-${videoId}`, generation: 5 })) },
  current: { permissions: { ...deniedCoursePermissions, manageContent: true },
    videos: [1, 2].map(videoId => ({ videoId, title: 'title', lesson: 'lesson' })),
    managementVideos: [1, 2].map(videoId => ({ videoId, title: 'title', lesson: 'lesson', management: { generation: 5 } })) },
};
const proof = { sessionHash: 'session', registrationId: 'db:school', subjectHash: 'subject' };

it('intersects fresh authority with course membership for every operation scope', () => {
  expect(learningConversationScope(access, 'actor', proof).ltiSubject?.resourceVideoIds).toEqual([1]);
  expect(learningReportScope(access, proof).readable.map(item => item.videoId)).toEqual([1]);
  const tags = learningTagScope(access, 'actor', proof);
  expect(tags.readableVideoIds).toEqual([1]);
  expect(tags.management.map(item => item.videoId)).toEqual([1]);
  expect(learningManagedMaterialScope(access, 2)).toBeNull();
  expect(learningManagedMaterialScope(access, 1)).toMatchObject({ videoId: 1, generation: 5, resourceLinkId: 'resource-1' });
});

it('never exports owner log IDs or feedback credentials and mints no export references', async () => {
  const reference = vi.fn().mockResolvedValue('new-reference');
  const turns = [{ id: 'turn', chatLogId: 42, feedbackToken: 'private-token', question: 'question' }];
  expect(await learningConversationTurns(turns, 'export', reference)).toEqual([{ id: 'turn', question: 'question' }]);
  expect(reference).not.toHaveBeenCalled();
  expect(await learningConversationTurns(turns, 'get', reference)).toEqual([{ id: 'turn', question: 'question', feedbackId: 'new-reference' }]);
  expect(reference).toHaveBeenCalledWith(42);
});

it('keeps committed durable work accepted when immediate dispatch fails', async () => {
  const material = { videoId: 1, title: 'title', description: '', transcript: '', status: 'indexing', revision: 'revision',
    canEdit: false, canReindex: false, canRetry: true, jobState: 'queued' };
  const deferred = vi.fn();
  const process = vi.fn().mockRejectedValue(new Error('provider secret must not escape'));
  const result = await executeLearningMaterialOperation({
    execute: vi.fn().mockResolvedValue({ material, externalTaskId: 7, reused: false }), process, dispatchDeferred: deferred,
  }, { ...learningManagedMaterialScope(access, 1)!, actorKey: 'actor', sessionProof: proof }, { action: 'reindex', videoId: 1, operationId: 'operation', revision: 'revision' });
  expect(result).toEqual({ material, reused: false, pending: true });
  expect(process).toHaveBeenCalledWith(7);
  expect(deferred).toHaveBeenCalledExactlyOnceWith();
});


it('keeps Q&A viewing, posting and moderation capabilities separate', () => {
  const viewer = { ...access, current: { ...access.current, permissions: { ...deniedCoursePermissions, viewQa: true, instructorQa: true } } };
  expect(canUseLearningQa(viewer, 'list')).toBe(true);
  for (const action of ['ask', 'reply', 'vote', 'feature', 'deleteQuestion', 'deleteReply']) expect(canUseLearningQa(viewer, action)).toBe(false);
  const moderator = { ...viewer, current: { ...viewer.current, permissions: { ...viewer.current.permissions, moderateQa: true } } };
  expect(canUseLearningQa(moderator, 'feature')).toBe(true);
  expect(canUseLearningQa(moderator, 'deleteQuestion')).toBe(true);
  expect(canUseLearningQa(moderator, 'ask')).toBe(false);
});
