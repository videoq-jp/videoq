import type { ChatAnswer, ChatContentPart, ChatSource } from '@videoq/domain/chat';
import { AnswerContentService } from '../features/chat/answer-content-service';
import { AnswerTextStream, adaptStructuredAnswerFailure } from './structured-answer';

/** SDK parser composition and provider failure formatting. */
export class AnswerContentStream {
  private readonly service = new AnswerContentService(new AnswerTextStream());
  push(delta: string, sources: readonly ChatSource[]): ChatContentPart[] {
    return adaptStructuredAnswerFailure(() => this.service.push(delta, sources));
  }
  finish(answer: ChatAnswer): ChatContentPart[] {
    return adaptStructuredAnswerFailure(() => this.service.finish(answer));
  }
}
