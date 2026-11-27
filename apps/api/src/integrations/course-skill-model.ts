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
  name: string; system: string; input: unknown; schema: Schema;
}): Promise<z.output<Schema>> {
  const input = JSON.stringify(options.input);
  if (input.length > 200_000) throw new Error('SKILL_MODEL_INPUT_TOO_LARGE');
  const admitted = await reserveAiAnswerUsage(env, ownerId);
  if (!('reservation' in admitted)) throw new Error('SKILL_QUOTA_EXCEEDED');
  const ledger = new AnswerCostLedger();
  let invoked = false, started = false;
  try {
    await startAnswerCostLedger(env, ledger, { planCode: admitted.reservation.planCode, quotaSource: admitted.reservation.quotaSource, hasCourse: true, streamed: false });
    started = true;
    const model = createChatModel(env, { timeoutMs: llmTimeoutMs(env), maxTokens: 8000, purpose: 'skill_generation', costLedger: ledger });
    invoked = true;
    const message = await model.invoke([new SystemMessage(options.system), new HumanMessage(input)], {
      response_format: { type: 'json_schema', json_schema: { name: options.name, strict: true, schema: z.toJSONSchema(options.schema) } },
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
