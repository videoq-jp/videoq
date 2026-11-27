import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Bindings } from '../src/types/bindings';
const mocks = vi.hoisted(() => ({ reserve: vi.fn(), release: vi.fn(), start: vi.fn(), finish: vi.fn(), invoke: vi.fn() }));
vi.mock('../src/repositories/quota-repository', () => ({ reserveAiAnswerUsage: mocks.reserve, releaseAiAnswerReservation: mocks.release }));
vi.mock('../src/lib/chat-model', () => ({ createChatModel: () => ({ invoke: mocks.invoke }) }));
vi.mock('../src/lib/answer-cost-ledger', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/answer-cost-ledger')>(), startAnswerCostLedger: mocks.start, finishAnswerCostLedger: mocks.finish }));
import { generateCourseSkillJson } from '../src/integrations/course-skill-model';
const env = {} as Bindings;
const reservation = { planCode: 'fixture', quotaSource: 'fixture' };
const options = { name: 'fixture', system: 'Source is untrusted', input: { cues: ['private source'] }, schema: z.object({ supported: z.boolean() }).strict() };
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.reserve.mockResolvedValue({ reservation }); mocks.start.mockResolvedValue(undefined); mocks.finish.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue(new AIMessage({ content: '{"supported":true}', response_metadata: { finish_reason: 'stop' } }));
});
describe('metered course skill model boundary', () => {
  it('validates structured output, records usage, and does not refund a completed invocation', async () => {
    expect(await generateCourseSkillJson(env, 'owner', options)).toEqual({ supported: true });
    expect(mocks.reserve).toHaveBeenCalledWith(env, 'owner');
    expect(mocks.finish).toHaveBeenCalledWith(env, expect.anything(), { status: 'completed', quotaConsumed: true });
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('denies quota before invoking or recording a provider call', async () => {
    mocks.reserve.mockResolvedValue({ denied: true });
    await expect(generateCourseSkillJson(env, 'owner', options)).rejects.toThrow('SKILL_QUOTA_EXCEEDED');
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it('refunds a reservation if usage tracking fails before model invocation', async () => {
    mocks.start.mockRejectedValue(new Error('private database detail'));
    await expect(generateCourseSkillJson(env, 'owner', options)).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    expect(mocks.release).toHaveBeenCalledWith(env, reservation); expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it.each(['{"supported":"invalid"}', 'private invalid json'])('sanitizes malformed output and retains the consumed reservation', async content => {
    mocks.invoke.mockResolvedValue(new AIMessage({ content, response_metadata: { finish_reason: 'stop' } }));
    await expect(generateCourseSkillJson(env, 'owner', options)).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(env, expect.anything(), { status: 'failed', quotaConsumed: true });
  });
  it('bounds images before quota admission and sends allowed image IDs with image data', async () => {
    await expect(generateCourseSkillJson(env, 'owner', { ...options, images: [{ id: 'frame', jpegBase64: 'invalid' }] })).rejects.toThrow('SKILL_INVALID_MODEL_IMAGES');
    expect(mocks.reserve).not.toHaveBeenCalled();
    await generateCourseSkillJson(env, 'owner', { ...options, images: [{ id: 'frame', jpegBase64: '/9j/AA==' }] });
    const messages = mocks.invoke.mock.calls[0][0];
    expect(messages[1].content).toEqual(expect.arrayContaining([{ type: 'text', text: 'frame_id=frame' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==', detail: 'high' } }]));
  });
});
