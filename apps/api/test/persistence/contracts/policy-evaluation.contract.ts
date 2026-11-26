import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { quotaAllowsAdditional, quotaAllowsNext, type QuotaComparison } from '../../../src/domain/billing/quota-policy';
import { videoAbortRefundAllowed, videoRefundBooleanLogic } from '../../../src/domain/media/video-mutation';
import { quotaDrizzleComparison } from '../../../src/persistence/quota-policy-sql';
import { videoMutationDrizzleLogic } from '../../../src/persistence/video-mutation-policy-sql';

export type Policy = 'refund' | 'additional' | 'next';
export interface PolicyFacts { status: string | null; bytes: number | null; used: number; limit: number | null; additional: number }
interface Fixture { evaluate(policy: Policy, facts: PolicyFacts): Promise<boolean>; dispose(): Promise<void> }
const arithmetic: QuotaComparison<number | null, boolean> = {
  isUnlimited: value => value === null,
  subtract: (left, right) => left === null || right === null ? null : left - right,
  atMost: (left, right) => left !== null && right !== null && left <= right,
  lessThan: (left, right) => left !== null && right !== null && left < right,
  or: (left, right) => left || right,
};

/** Use the actual production SQL interpreters in an UPDATE, not a string snapshot. */
export function policyUpdate(policy: Policy): SQL {
  const predicate = policy === 'refund'
    ? videoAbortRefundAllowed(sql`status`, sql`bytes`, videoMutationDrizzleLogic)
    : policy === 'additional'
      ? quotaAllowsAdditional(sql`used`, sql`quota_limit`, sql`additional`, quotaDrizzleComparison)
      : quotaAllowsNext(sql`used`, sql`quota_limit`, quotaDrizzleComparison);
  return sql`UPDATE policy_facts SET applied=1 WHERE ${predicate}`;
}

export function policyEvaluationContract(backend: string, create: () => Promise<Fixture>) {
  describe(`${backend}: pure policies versus atomic SQL decisions`, () => {
    let fixture: Fixture | undefined;
    beforeAll(async () => { fixture = await create(); }, 30_000);
    afterAll(async () => { await fixture?.dispose(); });
    const current = () => { if (!fixture) throw new Error('Policy fixture missing'); return fixture; };
    it('matches refund decisions for NULL, negative, zero and positive facts', async () => {
      for (const status of ['uploading', 'completed', 'pending', null]) {
        for (const bytes of [null, -1, 0, 1, 5, Number.MAX_SAFE_INTEGER]) {
          const facts = { status, bytes, used: 0, limit: 10, additional: 1 };
          expect(await current().evaluate('refund', facts), JSON.stringify(facts))
            .toBe(videoAbortRefundAllowed(status, bytes, videoRefundBooleanLogic));
        }
      }
    });
    it('matches additional quota at equality, overflow of allowance and unlimited limits', async () => {
      for (const used of [0, 1, 9, 10, 11, Number.MAX_SAFE_INTEGER]) {
        for (const limit of [null, 0, 10, Number.MAX_SAFE_INTEGER]) {
          for (const additional of [0, 1, 10, Number.MAX_SAFE_INTEGER]) {
            const facts = { status: 'uploading', bytes: 1, used, limit, additional };
            expect(await current().evaluate('additional', facts), JSON.stringify(facts))
              .toBe(quotaAllowsAdditional(used, limit, additional, arithmetic));
          }
        }
      }
    });
    it('preserves strict next-item quota equality versus inclusive storage equality', async () => {
      for (const used of [0, 1, 9, 10, 11, Number.MAX_SAFE_INTEGER]) {
        for (const limit of [null, 0, 10, Number.MAX_SAFE_INTEGER]) {
          const facts = { status: 'completed', bytes: null, used, limit, additional: 0 };
          expect(await current().evaluate('next', facts), JSON.stringify(facts)).toBe(quotaAllowsNext(used, limit, arithmetic));
        }
      }
    });
  });
}
