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

import type { AdminFlagsPatch } from '../src/domain/identity/admin';
import type { RpcInputMap } from '@videoq/trpc';
import type { LearningGrant, NativeLearningClaims } from '../src/domain/lms/native-learning';
import type { sessionRecord } from '../src/features/lti/protocol';
import type { nativeAssertionClaims } from '../src/features/lms/native-auth';
export type AdminFlagsCompatibility = Assert<Equal<AdminFlagsPatch, Omit<RpcInputMap['admin.patchFlags'], 'id'>>>;
export type LearningGrantCompatibility = Assert<Equal<LearningGrant, z.infer<typeof sessionRecord>>>;
export type NativeClaimsCompatibility = Assert<Equal<NativeLearningClaims,
  Pick<z.infer<typeof nativeAssertionClaims>, keyof NativeLearningClaims>>>;

import type { AdminQuotaPatch, AdminUsagePatch } from '../src/domain/identity/admin';
export type AdminQuotaCompatibility = Assert<Equal<AdminQuotaPatch, Omit<RpcInputMap['admin.patchQuota'], 'id'>>>;
export type AdminUsageCompatibility = Assert<Equal<AdminUsagePatch, Omit<RpcInputMap['admin.patchUsage'], 'id'>>>;

import type { LtiLoginRecord } from '../src/domain/lms/lti-launch';
import type { loginRecord } from '../src/features/lti/protocol';
export type LoginRecordCompatibility = Assert<Equal<LtiLoginRecord, z.infer<typeof loginRecord>>>;

import type { ClassroomConfig, ClassroomLaunch, ClassroomAccount, ClassroomMaterial } from '../src/application/classroom';
import type { ClassroomConfig as Config, launchSchema, materialSchema } from '../src/features/classroom/config';
import type { accountSchema } from '../src/features/classroom/oauth';
export type ClassroomConfigCompatibility = Assert<Equal<ClassroomConfig, Config>>;
export type ClassroomLaunchCompatibility = Assert<Equal<ClassroomLaunch, z.infer<typeof launchSchema>>>;
export type ClassroomMaterialCompatibility = Assert<Equal<ClassroomMaterial, z.infer<typeof materialSchema>>>;
export type ClassroomAccountCompatibility = Assert<Equal<ClassroomAccount, z.infer<typeof accountSchema>>>;

import type { ManagementIdentity, ManagementContext } from '../src/domain/lms/lms-management';
import type { moodleManagementRequest, moodleManagementContext } from '@videoq/trpc/moodle-management';
export type ManagementIdentityCompatibility = Assert<Equal<ManagementIdentity, z.infer<typeof moodleManagementRequest>>>;
export type ManagementContextCompatibility = Assert<Equal<ManagementContext, z.infer<typeof moodleManagementContext>>>;

import type { ClassroomStoredSession } from '../src/features/classroom/workflow-service';
import type { classroomSession } from '../src/features/classroom/authorization';
export type ClassroomSessionCompatibility = Assert<ClassroomStoredSession extends z.infer<typeof classroomSession> ? true : false>;
export type ClassroomSessionReverseCompatibility = Assert<z.infer<typeof classroomSession> extends ClassroomStoredSession ? true : false>;
