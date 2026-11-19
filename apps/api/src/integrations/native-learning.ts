import { createNativeLearningService } from '../features/lms/native-learning-service';
import { courseAccessContext } from '../features/lti/course-access';
import { registrationFingerprint } from '../features/lti/session-authorization';
import { digest } from '../features/lti/store';
import { ensureNativeSession } from '../features/lms/native-session';
import { getCourseWithMembers } from '../repositories/chat-repository';
import type { Bindings } from '../types/bindings';

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
