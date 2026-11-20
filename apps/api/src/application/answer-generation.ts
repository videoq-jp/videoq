import type { ChatAnswer, ModelAnswer } from '@videoq/domain/chat';

/** Generated answer data and an opaque committed-state pointer. */
export type GenerationResult = {
  queryText: string; answer: ChatAnswer; retrievedContexts: string[];
  checkpointId?: string;
  persistedTurn?: { chatLogId: number | null; feedback: string | null };
};

/** The final answer must preserve every provisional text and citation already emitted. */
export class StructuredAnswerError extends Error {
  readonly name = 'StructuredAnswerError';
}

/** A schema-valid answer still needs visible text to count as an answer. */
export function assertAnswerHasText(answer: ModelAnswer): void {
  if (!answer.segments.some(segment => segment.text.trim())) {
    throw new StructuredAnswerError('Invalid structured answer.');
  }
}

export type CancellationState = { readonly aborted: boolean };
