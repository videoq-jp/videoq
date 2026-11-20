import { describe, expect, it, vi } from 'vitest';
import type { LearningAuthorization } from '../src/application/lti-authorization';
import { deniedCoursePermissions } from '../src/application/lms-authority';
import { completeLearningChat, readLearningHistory, readLearningTranscript, updateLearningFeedback } from '../src/features/lti/learning-service';

const access: LearningAuthorization = {
  sessionHash: 'session',
  grant: { registrationId: 'reg', registrationHash: 'hash', deploymentId: 'deployment', contextId: 'context',
    resourceLinkId: 'resource', locale: 'ja', courseId: 12, subjectHash: 'subject', roles: [] },
  reg: { id: 'reg', issuer: 'issuer', clientId: 'client', authorizationUrl: 'authorize', jwksUrl: 'keys', frameOrigins: [], resources: [] },
};
const course = { id: 12, userId: 'owner', memberVideoIds: [1] };
function feedbackDependencies() {
  return {
    reference: vi.fn().mockResolvedValue({ sessionHash: 'session', courseId: 12, logId: 42 }),
    current: vi.fn().mockResolvedValue(null),
    course: vi.fn().mockResolvedValue(course),
    throttle: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ id: 42, feedback: 'good' }),
  };
}

describe('learning workflows without HTTP or persistence implementations', () => {
  it('rejects another session before authority, rate limiting or feedback writes', async () => {
    const deps = feedbackDependencies();
    deps.reference.mockResolvedValue({ sessionHash: 'other', courseId: 12, logId: 42 });
    expect(await updateLearningFeedback(access, 'opaque', 'good', deps)).toEqual({ denied: true });
    expect(deps.current).not.toHaveBeenCalled();
    expect(deps.course).not.toHaveBeenCalled();
    expect(deps.throttle).not.toHaveBeenCalled();
    expect(deps.update).not.toHaveBeenCalled();
  });
  it('stops after revoked authority without consuming a throttle slot', async () => {
    const deps = feedbackDependencies();
    deps.current.mockRejectedValue(new Error('authority unavailable'));
    expect(await updateLearningFeedback(access, 'opaque', 'good', deps)).toEqual({ denied: true });
    expect(deps.course).not.toHaveBeenCalled();
    expect(deps.throttle).not.toHaveBeenCalled();
    expect(deps.update).not.toHaveBeenCalled();
  });
  it('returns the opaque throttle refusal before writing for legacy static access', async () => {
    const deps = feedbackDependencies();
    const refusal = { retryAfter: 10 };
    deps.throttle.mockResolvedValue(refusal);
    expect(await updateLearningFeedback(access, 'opaque', 'good', deps)).toEqual({ throttled: refusal });
    expect(deps.update).not.toHaveBeenCalled();
  });
  it('does not mint feedback credentials when history persistence fails', async () => {
    const failure = new Error('history commit failed');
    const feedback = vi.fn();
    await expect(completeLearningChat('question', 42, [1], {
      append: vi.fn().mockRejectedValue(failure), feedback,
    })).rejects.toBe(failure);
    expect(feedback).not.toHaveBeenCalled();
  });
  it('projects history into session references without exposing owner log identifiers', async () => {
    const turns = vi.fn().mockResolvedValue([{ id: 'turn', logId: 42, question: 'question' }]);
    const feedback = vi.fn().mockResolvedValue('session-reference');
    const result = await readLearningHistory(access, {
      current: vi.fn().mockResolvedValue(null), course: vi.fn().mockResolvedValue(course), turns, feedback,
    });
    expect(result).toEqual({ turns: [{ id: 'turn', question: 'question', feedbackId: 'session-reference' }] });
    expect(turns).toHaveBeenCalledWith('owner', [1]);
    expect(feedback).toHaveBeenCalledWith(42);
  });
  it('does not fetch transcript evidence when permission is missing', async () => {
    const read = vi.fn();
    const result = await readLearningTranscript({ course, current: {
      videos: [{ videoId: 1, lesson: 'lesson', title: 'title' }], permissions: deniedCoursePermissions,
    } }, { videoId: 1, cursor: 0, limit: 50 }, read);
    expect(result).toEqual({ denied: true });
    expect(read).not.toHaveBeenCalled();
  });
});
