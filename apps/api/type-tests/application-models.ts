import type { ChatAnswer, ChatSource, VideoStatus, VideoSourceType } from '../src/application/models';
import type { ChatAnswer as RpcChatAnswer, ChatSource as RpcChatSource } from '@videoq/trpc/chat';
import type { VideoStatus as RpcVideoStatus, VideoSourceType as RpcVideoSourceType } from '@videoq/trpc';

// Application models stay independent; the outer contract must remain lossless.
// Compiled by the regular API typecheck command, with no runtime imports.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type ChatAnswerCompatibility = Assert<Equal<ChatAnswer, RpcChatAnswer>>;
export type ChatSourceCompatibility = Assert<Equal<ChatSource, RpcChatSource>>;
export type VideoStatusCompatibility = Assert<Equal<VideoStatus, RpcVideoStatus>>;
export type VideoSourceCompatibility = Assert<Equal<VideoSourceType, RpcVideoSourceType>>;

import type { z } from 'zod';
import type { TeachingTicket } from '../src/application/teaching';
import type { ticketSchema } from '../src/shared/teaching';
export type TeachingTicketCompatibility = Assert<Equal<TeachingTicket, z.infer<typeof ticketSchema>>>;
