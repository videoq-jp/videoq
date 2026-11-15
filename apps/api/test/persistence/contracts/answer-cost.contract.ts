import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { AnswerCostLedger, startAnswerCostLedger, finishAnswerCostLedger } from '../../../src/lib/answer-cost-ledger';
import type { Bindings } from '../../../src/types/bindings';
export type AnswerCostFixture = {
    env: Bindings;
    read(id: string): Promise<Record<string, unknown> | null>;
    dispose(): Promise<void>;
};
export function normalizeAnswerCostRow(row: Record<string, unknown> | undefined) {
    if (!row)
        return null;
    const iso = (value: unknown) => { if (!(value instanceof Date) && typeof value !== 'string')
        throw new Error('Missing ledger timestamp'); return new Date(value).toISOString(); };
    return { ...row, started_at: iso(row.started_at), finished_at: row.finished_at === null ? null : iso(row.finished_at), has_course: Boolean(row.has_course), streamed: Boolean(row.streamed), quota_consumed: row.quota_consumed === null ? null : Boolean(row.quota_consumed), provider_calls: typeof row.provider_calls === 'string' ? JSON.parse(row.provider_calls) as unknown : row.provider_calls };
}
const scope = { planCode: 'basic', quotaSource: 'admin', hasCourse: true, streamed: false };
export function answerCostContract(name: string, create: () => Promise<AnswerCostFixture>) {
    describe(`${name}: answer cost lifecycle through shared service`, () => {
        let f: AnswerCostFixture;
        beforeEach(async () => { f = await create(); });
        afterEach(async () => { await f?.dispose(); });
        it('starts an anonymous attempt with normalized flags and server timestamps', async () => {
            const ledger = new AnswerCostLedger();
            await startAnswerCostLedger(f.env, ledger, scope);
            const row = await f.read(ledger.id);
            expect(row).toMatchObject({ id: ledger.id, plan_code: 'basic', quota_source: 'admin', has_course: true, streamed: false, status: 'started', quota_consumed: null, finished_at: null, provider_calls: [] });
            expect(Object.keys(row!).sort()).toEqual(['id', 'started_at', 'finished_at', 'plan_code', 'quota_source', 'has_course', 'streamed', 'status', 'quota_consumed', 'provider_calls'].sort());
            expect(row!.started_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
        });
        it('persists numeric provider usage while removing content and unfinished call ambiguity', async () => {
            const ledger = new AnswerCostLedger();
            await startAnswerCostLedger(f.env, ledger, scope);
            ledger.begin('answer_model', 'existing-model').complete({ prompt_tokens: 10, details: { cached_tokens: 3 }, prompt: 'private-question', headers: { authorization: 'private-token' } });
            ledger.begin('query_embedding', 'existing-embedding');
            await finishAnswerCostLedger(f.env, ledger, { status: 'interrupted', quotaConsumed: false });
            const row = await f.read(ledger.id);
            expect(row).toMatchObject({ status: 'interrupted', quota_consumed: false, finished_at: expect.any(String), provider_calls: [{ kind: 'answer_model', status: 'completed', usage: { prompt_tokens: 10, details: { cached_tokens: 3 } } }, { kind: 'query_embedding', status: 'interrupted', finishedAt: expect.any(String), usage: null }] });
            expect(JSON.stringify(row)).not.toContain('private-question');
            expect(JSON.stringify(row)).not.toContain('private-token');
        });
        it('records exactly one terminal outcome under concurrent completion and preserves it on replay', async () => {
            const ledger = new AnswerCostLedger();
            await startAnswerCostLedger(f.env, ledger, scope);
            ledger.begin('answer_model', 'existing-model').complete({ completion_tokens: 2 });
            await Promise.all([finishAnswerCostLedger(f.env, ledger, { status: 'completed', quotaConsumed: true }), finishAnswerCostLedger(f.env, ledger, { status: 'failed', quotaConsumed: false })]);
            const first = await f.read(ledger.id);
            expect(['completed', 'failed']).toContain(first!.status);
            expect(first!.quota_consumed).toBe(first!.status === 'completed');
            ledger.begin('query_embedding', 'late-call').fail();
            await finishAnswerCostLedger(f.env, ledger, { status: 'interrupted', quotaConsumed: false });
            expect(await f.read(ledger.id)).toEqual(first);
        });
        it('does not create an attempt when a finish arrives without a successful start', async () => {
            const ledger = new AnswerCostLedger();
            await finishAnswerCostLedger(f.env, ledger, { status: 'failed', quotaConsumed: false });
            expect(await f.read(ledger.id)).toBeNull();
        });
        it('rejects duplicate starts without resetting the original scope', async () => {
            const ledger = new AnswerCostLedger();
            await startAnswerCostLedger(f.env, ledger, scope);
            await expect(startAnswerCostLedger(f.env, ledger, { ...scope, planCode: 'replacement' })).rejects.toThrow();
            expect((await f.read(ledger.id))!.plan_code).toBe('basic');
        });
    });
}
