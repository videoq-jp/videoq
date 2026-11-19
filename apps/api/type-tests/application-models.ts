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

import type { AdminFlagsPatch } from '../src/application/admin';
import type { RpcInputMap } from '@videoq/trpc';
import type { LearningGrant, NativeLearningClaims } from '../src/application/native-learning';
import type { sessionRecord } from '../src/features/lti/protocol';
import type { nativeAssertionClaims } from '../src/features/lms/native-auth';
export type AdminFlagsCompatibility = Assert<Equal<AdminFlagsPatch, Omit<RpcInputMap['admin.patchFlags'], 'id'>>>;
export type LearningGrantCompatibility = Assert<Equal<LearningGrant, z.infer<typeof sessionRecord>>>;
export type NativeClaimsCompatibility = Assert<Equal<NativeLearningClaims,
  Pick<z.infer<typeof nativeAssertionClaims>, keyof NativeLearningClaims>>>;
