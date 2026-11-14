import { and, eq, sql } from 'drizzle-orm';
import { createD1Connection } from '../../db/d1/connection';
import { aiAnswerAttempts } from '../../db/schema/sqlite';
import type { AnswerCostRepository } from '../contracts/answer-cost-repository';
export function createD1AnswerCostRepository(database: D1Database): AnswerCostRepository {
    const db = createD1Connection(database);
    return {
        async start(input) { await db.insert(aiAnswerAttempts).values({ ...input, status: 'started' }); },
        async finish(id, outcome) {
            await db.update(aiAnswerAttempts).set({
                finishedAt: sql `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
                status: outcome.status, quotaConsumed: outcome.quotaConsumed,
                providerCalls: outcome.providerCalls.map(call => ({ ...call })),
            }).where(and(eq(aiAnswerAttempts.id, id), eq(aiAnswerAttempts.status, 'started')));
        },
    };
}
