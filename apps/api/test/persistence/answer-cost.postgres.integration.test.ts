import { describe } from 'vitest';
import { readFile } from 'node:fs/promises';
import { isolatedPostgres } from './isolated-postgres';
import { answerCostContract, normalizeAnswerCostRow } from './contracts/answer-cost.contract';
import type { Bindings } from '../../src/types/bindings';
const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('PostgreSQL answer cost', () => {
    answerCostContract('PostgreSQL onprem', async () => {
        const f = await isolatedPostgres(url!);
        try {
            const migration = await readFile(new URL('../../drizzle/0036_nosy_gorilla_man.sql', import.meta.url), 'utf8');
            await f.pool.query(migration, []);
        }
        catch (error) {
            await f.dispose();
            throw error;
        }
        return { env: { DEPLOYMENT_EDITION: 'onprem', DATABASE_POOL: f.pool } as Bindings,
            read: async (id) => normalizeAnswerCostRow((await f.pool.query<Record<string, unknown>>('SELECT * FROM ai_answer_attempts WHERE id=$1', [id])).rows[0]), dispose: f.dispose };
    });
});
