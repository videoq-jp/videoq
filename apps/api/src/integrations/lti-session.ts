import type { LtiSessionDependencies } from '../features/lti/session-service';
import { loginRecord, sessionRecord, verifyLaunch } from '../features/lti/protocol';
import { consumeLogin, digest, putCredential, randomSecret, readCredential } from '../features/lti/store';
import { registrationFingerprint } from '../features/lti/session-authorization';
import { courseAccessContext } from '../features/lti/course-access';
import { getCourseWithMembers } from '../repositories/chat-repository';
import type { Bindings } from '../types/bindings';

export function ltiSessionDependencies(env: Bindings): LtiSessionDependencies {
  return {
    loadLogin: async state => { const result = loginRecord.safeParse(await readCredential(env, state, 'login')); return result.success ? result.data : null; },
    loadSession: async hash => { const result = sessionRecord.safeParse(await readCredential(env, hash, 'session')); return result.success ? result.data : null; },
    saveLogin: (id, login, seconds) => putCredential(env, id, 'login', login, seconds),
    saveSession: (id, grant, seconds) => putCredential(env, id, 'session', grant, seconds),
    consumeLogin: state => consumeLogin(env, state), newSecret: randomSecret, digest,
    fingerprint: registrationFingerprint, verify: verifyLaunch,
    course: id => getCourseWithMembers(env, { courseId: id, ltiCourseGrant: id }),
    access: (reg, grant) => courseAccessContext(reg, grant, env),
  };
}
