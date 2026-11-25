import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { createLangChainCompressor } from '@videoq-jp/langchainjs-optchat';
import { createOptChatMiddleware } from '@videoq-jp/langchainjs-optchat/middleware';
import { createChatModel } from './chat-model';
import type { Bindings } from '../types/bindings';
import type { AnswerCostLedger } from './answer-cost-ledger';

class SummaryProgressObserver extends BaseCallbackHandler {
  name = 'conversationSummaryProgress';
  awaitHandlers = true;
  constructor(private readonly onStart?: () => void) { super(); }
  handleChatModelStart() { this.onStart?.(); }
}

/** Keep originals and the incremental OptChat tree in the existing LangGraph checkpoint. */
export function conversationCompaction(env: Bindings, timeoutMs: number, costLedger?: AnswerCostLedger, onSummaryStart?: () => void) {
  return [createOptChatMiddleware({
    compressor: createLangChainCompressor(createChatModel(env, {
      timeoutMs, costLedger, purpose: 'conversation_summary',
      callbacks: [new SummaryProgressObserver(onSummaryStart)],
    })),
    // Bound concurrent summary requests on Workers; retain upstream byte budgets.
    memoryOptions: { jobs: 2 },
  })] as const;
}
