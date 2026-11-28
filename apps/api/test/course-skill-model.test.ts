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
    expect(mocks.invoke.mock.calls[0][1].response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
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
  it('uses Workers AI JSON mode without weakening server-side string validation', async () => {
    const schema = z.object({ slug: z.string().regex(/^[a-z]+$/).max(4), notes: z.array(z.string().max(20)) }).strict();
    mocks.invoke.mockResolvedValue(new AIMessage({ content: '{"slug":"validtoolong","notes":[]}', response_metadata: { finish_reason: 'stop' } }));
    await expect(generateCourseSkillJson({ LLM_MODEL: '@cf/fixture' } as Bindings, 'owner', { ...options, schema })).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    expect(mocks.invoke.mock.calls[0][1].response_format).toEqual({ type: 'json_object' });
    const system = mocks.invoke.mock.calls[0][0][0].content;
    const { $schema: _dialect, ...validationRules } = z.toJSONSchema(schema);
    expect(system).toContain(JSON.stringify(validationRules));
    expect(system).not.toContain('"$schema"');
    expect(system).toContain('all required fields and no extra keys');
    expect(schema.safeParse({ slug: 'validtoolong', notes: [] }).success).toBe(false);
  });
  it('rejects extra JSON-mode fields and sanitizes the model response', async () => {
    mocks.invoke.mockResolvedValue(new AIMessage({ content: '{"supported":true,"extra":"private source"}', response_metadata: { finish_reason: 'stop' } }));
    await expect(generateCourseSkillJson({ LLM_MODEL: '@cf/fixture' } as Bindings, 'owner', options)).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    expect(mocks.finish).toHaveBeenCalledWith(expect.anything(), expect.anything(), { status: 'failed', quotaConsumed: true });
  });
  it.each(['{"supported":true,"issues":[]}', '{"supported":true,"issues":['])('rejects truncated constrained audits without accepting partial output or retrying inside the model boundary', async content => {
    const schema = z.object({ supported: z.boolean(), issues: z.array(z.string().min(1).max(2000)).max(32) }).strict();
    mocks.invoke.mockResolvedValue(new AIMessage({ content, response_metadata: { finish_reason: 'length' } }));
    await expect(generateCourseSkillJson({ LLM_MODEL: '@cf/fixture' } as Bindings, 'owner', { ...options, name: 'skill_draft_audit', schema, structuredOutput: true })).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'skill_draft_audit', strict: true, schema: z.toJSONSchema(schema) } });
    expect(mocks.finish).toHaveBeenCalledWith(expect.anything(), expect.anything(), { status: 'failed', quotaConsumed: true });
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it.each(['toolong', 'BAD'])('lowers incompatible grammar lengths but retains full server validation for %s', async slug => {
    const schema = z.object({ proposals: z.array(z.object({ slug: z.string().regex(/^[a-z]+$/).min(1).max(4) }).strict()), issues: z.array(z.string().max(20)) }).strict();
    const original = z.toJSONSchema(schema);
    mocks.invoke.mockResolvedValue(new AIMessage({ content: JSON.stringify({ proposals: [{ slug }], issues: [] }), response_metadata: { finish_reason: 'stop' } }));
    await expect(generateCourseSkillJson({ LLM_MODEL: '@cf/fixture' } as Bindings, 'owner', { ...options, schema, structuredOutput: true })).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    const wire = mocks.invoke.mock.calls[0][1].response_format;
    expect(wire.type).toBe('json_schema');
    expect(wire.json_schema.schema.properties.proposals.items.properties.slug).toEqual({ type: 'string', pattern: '^[a-z]+$' });
    expect(wire.json_schema.schema.properties.issues.items.maxLength).toBe(20);
    expect(z.toJSONSchema(schema)).toEqual(original);
    expect(mocks.invoke.mock.calls[0][0][0].content).toContain('"maxLength":4');
    expect(mocks.finish).toHaveBeenCalledWith(expect.anything(), expect.anything(), { status: 'failed', quotaConsumed: true });
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it.each([
    '{"evidence":[{"cueId":"cue-2115900"}]}',
    '{"evidence":[{"cueId":"cue-970","quote":"invented"}]}',
  ])('keeps source validation and metering when constrained output violates its schema', async content => {
    const schema = z.object({ evidence: z.array(z.object({ cueId: z.enum(['cue-970', 'cue-972']) }).strict()).min(1) }).strict();
    mocks.invoke.mockResolvedValue(new AIMessage({ content, response_metadata: { finish_reason: 'stop' } }));
    await expect(generateCourseSkillJson({ LLM_MODEL: '@cf/fixture' } as Bindings, 'owner', { ...options, schema, structuredOutput: true })).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0][1].response_format).toEqual({ type: 'json_schema', json_schema: { name: options.name, strict: true, schema: z.toJSONSchema(schema) } });
    expect(mocks.finish).toHaveBeenCalledWith(expect.anything(), expect.anything(), { status: 'failed', quotaConsumed: true });
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it.each([JSON.stringify(z.toJSONSchema(options.schema)), '{"supported":true,"$schema":"https://json-schema.org/draft/2020-12/schema"}'])('rejects schema metadata in returned data and accounts for the attempted call', async content => {
    mocks.invoke.mockResolvedValue(new AIMessage({ content, response_metadata: { finish_reason: 'stop' } }));
    await expect(generateCourseSkillJson({ LLM_MODEL: '@cf/fixture' } as Bindings, 'owner', options)).rejects.toThrow('SKILL_MODEL_GENERATION_FAILED');
    expect(mocks.finish).toHaveBeenCalledWith(expect.anything(), expect.anything(), { status: 'failed', quotaConsumed: true });
    expect(mocks.release).not.toHaveBeenCalled();
  });

});
