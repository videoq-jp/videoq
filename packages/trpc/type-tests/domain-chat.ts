import type { z } from 'zod';
import type { ChatAnswer, ChatSource, ModelAnswer, ChatStreamEvent, ChatToolProgressEvent } from '@videoq/domain/chat';
import type { chatAnswerSchema, chatSourceSchema, modelAnswerSchema } from '../src/chat-answer';
import type { chatStreamEventSchema, chatToolProgressEventSchema } from '../src/chat';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type AnswerMatches = Assert<Equal<ChatAnswer, z.infer<typeof chatAnswerSchema>>>;
export type SourceMatches = Assert<Equal<ChatSource, z.infer<typeof chatSourceSchema>>>;
export type ModelMatches = Assert<Equal<ModelAnswer, z.infer<typeof modelAnswerSchema>>>;
export type EventsMatch = Assert<Equal<ChatStreamEvent, z.infer<typeof chatStreamEventSchema>>>;
export type ToolEventsMatch = Assert<Equal<ChatToolProgressEvent, z.infer<typeof chatToolProgressEventSchema>>>;
