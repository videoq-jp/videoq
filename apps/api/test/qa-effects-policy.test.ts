import { expect, it } from 'vitest';
import { qaBooleanLogic, qaMutationEffects, type QaOperation } from '../src/features/qa/policy';

const facts = { ownQuestion: false, ownReply: false, featureChanged: true, featured: true };
it.each<QaOperation>(['qa.ask', 'qa.updateQuestion', 'qa.deleteQuestion', 'qa.reply', 'qa.updateReply', 'qa.deleteReply', 'qa.vote', 'qa.feature'])('touches parent timestamps only for reply changes: %s', operation => {
  expect(qaMutationEffects(operation, facts, qaBooleanLogic).touchQuestion)
    .toBe(['qa.reply', 'qa.updateReply', 'qa.deleteReply'].includes(operation));
});

it('audits moderation of others while keeping question and reply authorship independent', () => {
  const mixed = { ...facts, ownQuestion: true };
  expect(qaMutationEffects('qa.deleteQuestion', mixed, qaBooleanLogic).moderation)
    .toEqual({ action: 'delete_question', when: false });
  expect(qaMutationEffects('qa.deleteReply', mixed, qaBooleanLogic).moderation)
    .toEqual({ action: 'delete_reply', when: true });
  expect(qaMutationEffects('qa.deleteReply', { ...mixed, ownReply: true }, qaBooleanLogic).moderation?.when).toBe(false);
});

it('audits feature transitions and suppresses repeated assignments', () => {
  expect(qaMutationEffects('qa.feature', facts, qaBooleanLogic).moderation).toEqual({ action: 'feature', when: true });
  expect(qaMutationEffects('qa.feature', { ...facts, featured: false }, qaBooleanLogic).moderation).toEqual({ action: 'unfeature', when: true });
  expect(qaMutationEffects('qa.feature', { ...facts, featureChanged: false }, qaBooleanLogic).moderation?.when).toBe(false);
  expect(qaMutationEffects('qa.vote', facts, qaBooleanLogic).moderation).toBeNull();
});
