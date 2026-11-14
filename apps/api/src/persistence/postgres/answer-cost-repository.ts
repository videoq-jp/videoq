import { and, eq, sql } from 'drizzle-orm';
import { withDb } from '../../db/pool';
import { aiAnswerAttempts } from '../../db/schema/modern';
import type { Bindings } from '../../types/bindings';
import type { AnswerCostRepository } from '../contracts/answer-cost-repository';
export function createPostgresAnswerCostRepository(env: Bindings): AnswerCostRepository {
    return {
        async start(input) { await withDb(env, db => db.insert(aiAnswerAttempts).values({ ...input, status: 'started' })); },
        async finish(id, outcome) {
            await withDb(env, db => db.update(aiAnswerAttempts).set({
                finishedAt: sql `clock_timestamp()`, status: outcome.status, quotaConsumed: outcome.quotaConsumed,
                providerCalls: outcome.providerCalls.map(call => ({ ...call })),
            }).where(and(eq(aiAnswerAttempts.id, id), eq(aiAnswerAttempts.status, 'started'))));
        },
    };
}
