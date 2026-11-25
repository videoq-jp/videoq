import { beforeEach, it, expect, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { extractedFactsSchema } from '@videoq/trpc/skills';
import { skillModelCall, readSkillMaterial } from '../src/integrations/agent-skills';
import { createChatModel } from '../src/lib/chat-model';
import { reserveAiAnswerUsage, releaseAiAnswerReservation } from '../src/repositories/quota-repository';
import { startAnswerCostLedger, finishAnswerCostLedger } from '../src/lib/answer-cost-ledger';
import { getCourseDetail } from '../src/repositories/course-repository';
import { getVideoDetail } from '../src/repositories/video-repository';
import type { Bindings } from '../src/types/bindings';
vi.mock('../src/lib/chat-model', async original => ({ ...await original<typeof import('../src/lib/chat-model')>(), createChatModel: vi.fn() }));
vi.mock('../src/repositories/quota-repository', () => ({ reserveAiAnswerUsage: vi.fn(), releaseAiAnswerReservation: vi.fn() }));
vi.mock('../src/lib/answer-cost-ledger', async original => ({ ...await original<typeof import('../src/lib/answer-cost-ledger')>(), startAnswerCostLedger: vi.fn(), finishAnswerCostLedger: vi.fn() }));
vi.mock('../src/repositories/course-repository', () => ({ getCourseDetail: vi.fn() }));
vi.mock('../src/repositories/video-repository', () => ({ getVideoDetail: vi.fn() }));
const env = {} as Bindings;
const reservation = { userId: 'owner', usagePeriodStart: '2026-11-25', planCode: 'test', quotaSource: 'test' };
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(reserveAiAnswerUsage).mockResolvedValue({ reservation });
  vi.mocked(startAnswerCostLedger).mockResolvedValue(); vi.mocked(finishAnswerCostLedger).mockResolvedValue();
});
it('reserves AI allowance before a model call and records completed invalid output as spent', async () => {
  vi.mocked(createChatModel).mockImplementation((_env, options) => ({ invoke: async () => {
    options.costLedger?.begin('skill_generation', 'fixture-model').complete({ prompt_tokens: 12, completion_tokens: 8 });
    return new AIMessage({ content: '{"wrong":true}', response_metadata: { finish_reason: 'stop' } });
  } }) as unknown as ReturnType<typeof createChatModel>);
  await expect(skillModelCall(env, 'owner', extractedFactsSchema, 'extract', 'extract facts', {})).rejects.toMatchObject({ code: 'SKILL_GENERATION_FAILED' });
  expect(releaseAiAnswerReservation).not.toHaveBeenCalled();
  expect(finishAnswerCostLedger).toHaveBeenCalledWith(env, expect.anything(), { status: 'failed', quotaConsumed: true });
});
it('refunds a provider failure and does not invoke a model without allowance', async () => {
  vi.mocked(createChatModel).mockReturnValue({ invoke: vi.fn().mockRejectedValue(new Error('Unavailable')) } as unknown as ReturnType<typeof createChatModel>);
  await expect(skillModelCall(env, 'owner', extractedFactsSchema, 'extract', 'extract facts', {})).rejects.toMatchObject({ code: 'SKILL_GENERATION_FAILED' });
  expect(releaseAiAnswerReservation).toHaveBeenCalledWith(env, reservation);
  vi.mocked(createChatModel).mockClear(); vi.mocked(reserveAiAnswerUsage).mockResolvedValue({ exceeded: true, limit: 1 });
  await expect(skillModelCall(env, 'owner', extractedFactsSchema, 'extract', 'extract facts', {})).rejects.toMatchObject({ status: 429 });
  expect(createChatModel).not.toHaveBeenCalled();
});
it('rejects non-owner courses before reading any private video and requires completed analysis', async () => {
  vi.mocked(getCourseDetail).mockResolvedValue({ access_role: 'member' } as never);
  await expect(readSkillMaterial(env, 'member', { kind: 'course', resourceId: 42 })).rejects.toThrow(/Owned course/);
  expect(getVideoDetail).not.toHaveBeenCalled();
  vi.mocked(getVideoDetail).mockResolvedValue({ id: 7, status: 'processing', transcript: 'Old transcript' } as never);
  await expect(readSkillMaterial(env, 'owner', { kind: 'video', resourceId: 7 })).rejects.toThrow(/Finish analysis/);
});
