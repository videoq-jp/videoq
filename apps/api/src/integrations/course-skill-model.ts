import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Bindings } from '../types/bindings';
import { createChatModel } from '../lib/chat-model';
import { assertCompletedAnswer } from '../lib/structured-answer';
import { llmTimeoutMs } from '../lib/llm';
import { reserveAiAnswerUsage, releaseAiAnswerReservation } from '../repositories/quota-repository';
import { AnswerCostLedger, startAnswerCostLedger, finishAnswerCostLedger } from '../lib/answer-cost-ledger';

/** One bounded, metered provider call. Source text never appears in propagated errors. */
export async function generateCourseSkillJson<Schema extends z.ZodType>(env: Bindings, ownerId: string, options: {
  name: string; system: string; input: unknown; schema: Schema; images?: { id: string; jpegBase64: string }[];
  /** Opt in only for schemas verified against the Workers AI grammar compiler. */
  structuredOutput?: boolean;
}): Promise<z.output<Schema>> {
  const input = JSON.stringify(options.input);
  const schema = z.toJSONSchema(options.schema);
  const workersAi = env.LLM_MODEL?.startsWith('@cf/');
  // The dialect URI is validator metadata, not an output field. Including it in
  // the JSON-mode prompt caused real models to copy $schema into otherwise valid data.
  const { $schema: _dialect, ...promptSchema } = schema;
  const schemaText = JSON.stringify(workersAi ? promptSchema : schema);
  const system = workersAi ? `${options.system}\nReturn one complete JSON object, with all required fields and no extra keys, matching this JSON Schema. Do not use Markdown or trailing commentary. JSON Schema: ${schemaText}\nThe schema above describes validation rules; it is not your answer. Return a data instance populated from the supplied input, never a copy or a rewritten schema. The root data fields are: ${Object.keys('properties' in schema ? schema.properties ?? {} : {}).join(', ')}.` : options.system;
  if (input.length + schemaText.length + system.length > 200_000) throw new Error('SKILL_MODEL_INPUT_TOO_LARGE');
  if (options.images && (options.images.length > 8 || options.images.some(image => !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image.jpegBase64) || image.jpegBase64.length > 349_528))) throw new Error('SKILL_INVALID_MODEL_IMAGES');
  const admitted = await reserveAiAnswerUsage(env, ownerId);
  if (!('reservation' in admitted)) throw new Error('SKILL_QUOTA_EXCEEDED');
  const ledger = new AnswerCostLedger();
  let invoked = false, started = false;
  try {
    await startAnswerCostLedger(env, ledger, { planCode: admitted.reservation.planCode, quotaSource: admitted.reservation.quotaSource, hasCourse: true, streamed: false });
    started = true;
    const model = createChatModel(env, { timeoutMs: llmTimeoutMs(env), maxTokens: 8000, purpose: 'skill_generation', costLedger: ledger });
    invoked = true;
    const message = await model.invoke([new SystemMessage(system), new HumanMessage(options.images?.length ? { content: [{ type: 'text', text: input }, ...options.images.flatMap(image => [{ type: 'text' as const, text: `frame_id=${image.id}` }, { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${image.jpegBase64}`, detail: 'high' as const } }])] } : input)], {
      response_format: workersAi && !options.structuredOutput ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: options.name, strict: true, schema } },
    });
    assertCompletedAnswer(message);
    const value = options.schema.parse(JSON.parse(message.text));
    await finishAnswerCostLedger(env, ledger, { status: 'completed', quotaConsumed: true });
    return value;
  } catch {
    if (started) {
      try { await finishAnswerCostLedger(env, ledger, { status: 'failed', quotaConsumed: invoked }); }
      catch { throw new Error('SKILL_USAGE_RECORD_FAILED'); }
    }
    throw new Error('SKILL_MODEL_GENERATION_FAILED');
  } finally {
    if (!invoked) await releaseAiAnswerReservation(env, admitted.reservation);
  }
}
