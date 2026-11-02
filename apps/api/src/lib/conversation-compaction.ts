import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { createMiddleware, summarizationMiddleware } from 'langchain';
import { LlmProviderError } from './openai';
import { createChatModel } from './chat-model';
import type { Bindings } from '../types/bindings';
import type { AnswerCostLedger } from './answer-cost-ledger';

export const SUMMARY_TRIGGER_TOKENS = 6_000;

class SummaryResultObserver extends BaseCallbackHandler {
  name = 'conversationSummaryResult';
  awaitHandlers = true;
  error: Error | undefined;
  handleLLMError(error: Error) { this.error = error; }
  handleLLMEnd(result: LLMResult) {
    if (!result.generations[0]?.[0]?.text.trim()) this.error = new Error('Empty conversation summary.');
  }
}

export function conversationCompaction(env: Bindings, timeoutMs: number, costLedger?: AnswerCostLedger) {
  const observer = new SummaryResultObserver();
  const middleware = summarizationMiddleware({
    model: createChatModel(env, { timeoutMs, costLedger, purpose: 'conversation_summary', callbacks: [observer] }),
    // No trigger means summarization never runs. Other options use library defaults.
    trigger: { tokens: SUMMARY_TRIGGER_TOKENS },
  });
  // Compose hooks through the public middleware API rather than replacing the
  // built-in hook (which also owns the middleware's state/context definitions).
  const validateSummary = createMiddleware({
    name: 'validateConversationSummary',
    beforeModel(_state, runtime) {
      runtime.signal?.throwIfAborted();
      // Observe failures via the public model callback API. Do not depend on
      // the built-in middleware's error-string wording or summary metadata.
      if (observer.error) throw new LlmProviderError('Conversation summarization failed.');
    },
  });
  return [middleware, validateSummary] as const;
}
