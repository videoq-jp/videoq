import { createNativeLearningService } from '../features/lms/native-learning-service';
import { courseAccessContext } from '../features/lti/course-access';
import { registrationFingerprint } from '../features/lti/session-authorization';
import { digest } from '../features/lti/store';
import { ensureNativeSession } from '../features/lms/native-session';
import { getCourseWithMembers } from '../repositories/chat-repository';
import type { Bindings } from '../types/bindings';
import { bootstrapNativeTeacher as executeTeacherBootstrap } from '../features/lms/native-teacher-service';
import type { LtiRegistration } from '../application/lti-registration';
import type { NativeLearningClaims } from '../application/native-learning';
import { MaterialsClient } from '../features/lms/connector-client';
import { createTeachingRepository } from '../persistence/factory';
import { issueTeachingTicket } from './teaching';
import { learningPlayback, type LearningPlaybackScope } from '../features/media/learning-playback-service';
import { classroomPlaybackVideo } from '../features/classroom/repository';
import { resolveFileUrl } from './media';

export function nativeLearningPlayback(env: Bindings, scope: LearningPlaybackScope, videoId: number) {
  return learningPlayback({
    playback: (owner, id) => classroomPlaybackVideo(env, owner, id),
    fileUrl: key => resolveFileUrl(env, key),
  }, scope, videoId);
}

export function bootstrapNativeTeacher(env: Bindings, reg: LtiRegistration, claims: NativeLearningClaims, title?: string) {
  return executeTeacherBootstrap({
    digest,
    access: (registration, identity) => new MaterialsClient(env, registration)
      .access(identity.contextId, identity.resourceLinkId, identity.subject),
    consumeNonce: async (id, expiresAt) => (await createTeachingRepository(env)).consumeBootstrapNonce(id, expiresAt),
    issueTicket: input => issueTeachingTicket(env, input),
  }, reg, claims, title);
}

export function nativeLearningService(env: Bindings) {
  return createNativeLearningService({
    digest, fingerprint: registrationFingerprint,
    access: (reg, grant) => courseAccessContext(reg, grant, env),
    loadCourse: (courseId, videoIds) => getCourseWithMembers(env, {
      courseId, ltiCourseGrant: courseId, ltiVideoGrant: videoIds,
    }),
    ensureSession: input => ensureNativeSession(env, input),
  });
}
