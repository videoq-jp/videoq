import { createD1Fixture } from './d1-fixture';
import { answerCostContract, normalizeAnswerCostRow } from './contracts/answer-cost.contract';
import type { Bindings } from '../../src/types/bindings';
answerCostContract('D1 workerd', async () => {
    const f = await createD1Fixture();
    return { env: { DEPLOYMENT_EDITION: 'cloud', DB: f.database } as Bindings,
        read: async (id) => normalizeAnswerCostRow((await f.database.prepare('SELECT * FROM ai_answer_attempts WHERE id=?').bind(id).first<Record<string, unknown>>()) ?? undefined), dispose: f.dispose };
});
