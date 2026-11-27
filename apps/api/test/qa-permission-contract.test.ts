import { expect, it } from 'vitest';
import { qaMutationAllowed, qaOperationPrecheck, qaBooleanLogic, type QaOperation } from '../src/domain/qa/policy';
it('derives every LTI mutation precheck from the same operation permission table as final authorization', () => {
  const operations: QaOperation[] = ['qa.ask', 'qa.reply', 'qa.vote', 'qa.feature', 'qa.updateQuestion', 'qa.deleteQuestion', 'qa.updateReply', 'qa.deleteReply'];
  for (let mask = 0; mask < 32; mask++) {
    const permissions = { view: !!(mask & 1), canPost: !!(mask & 2), canVote: !!(mask & 4), canDeleteOwn: !!(mask & 8), canModerate: !!(mask & 16) };
    for (const operation of operations) {
      const someOwnerAllowed = [false, true].some(ownQuestion => [false, true].some(ownReply => qaMutationAllowed(operation, permissions, ownQuestion, ownReply, qaBooleanLogic)));
      expect(qaOperationPrecheck(operation.slice(3), permissions)).toBe(permissions.view && someOwnerAllowed);
    }
  }
});
