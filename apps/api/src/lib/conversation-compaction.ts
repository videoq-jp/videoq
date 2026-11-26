import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { summarizationMiddleware } from 'langchain';
import { createChatModel } from './chat-model';
import type { Bindings } from '../types/bindings';
import type { AnswerCostLedger } from './answer-cost-ledger';

class SummaryProgressObserver extends BaseCallbackHandler {
  name = 'conversationSummaryProgress';
  awaitHandlers = true;
  constructor(private readonly onStart?: () => void) { super(); }
  handleChatModelStart() { this.onStart?.(); }
}

/** Use official history summarization and persist its result in native agent state. */
export function conversationCompaction(env: Bindings, timeoutMs: number, costLedger?: AnswerCostLedger, onSummaryStart?: () => void) {
  return [summarizationMiddleware({
    model: createChatModel(env, {
      timeoutMs, costLedger, purpose: 'conversation_summary',
      callbacks: [new SummaryProgressObserver(onSummaryStart)],
    }),
    // Absolute counts also support compatible models without context-window profiles.
    trigger: { tokens: 8192 },
    keep: { messages: 20 },
  })] as const;
}
