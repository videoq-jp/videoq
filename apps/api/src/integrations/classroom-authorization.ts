import { classroomAccess as access, authorizeAttachment as authorize } from '../features/classroom/authorization-service';
import type { ClassroomAuthorizationDependencies } from '../features/classroom/authorization-service';
import type { ClassroomLaunch } from '../application/classroom';
import type { Bindings } from '../types/bindings';
import { classroomConfig } from '../features/classroom/config';
import { readAccount } from '../features/classroom/oauth';
import { getContext, getAttachment } from '../features/classroom/client';
import { teachingConnection } from '../features/teaching/service';
import { getCourseWithMembers } from '../repositories/chat-repository';
import { classroomVideoSummaries } from '../features/classroom/repository';
import { digest } from '../features/lti/store';
import { ltiSubjectKey } from '../features/lti/identity';

export function classroomAuthorizationDependencies(env: Bindings): ClassroomAuthorizationDependencies {
  return {
    clientId: env.CLASSROOM_CLIENT_ID!, config: () => classroomConfig(env),
    account: token => readAccount(env, token), context: getContext, attachment: getAttachment,
    connection: courseId => teachingConnection(env, 'classroom', env.CLASSROOM_CLIENT_ID!, courseId),
    course: input => getCourseWithMembers(env, input),
    summaries: (owner, ids) => classroomVideoSummaries(env, owner, ids),
    fingerprint: config => digest(JSON.stringify([config, env.CLASSROOM_CLIENT_ID])),
    digest, subjectKey: ltiSubjectKey,
  };
}
export function classroomAccess(env: Bindings, launch: ClassroomLaunch, token: string) {
  return access(classroomAuthorizationDependencies(env), launch, token);
}
export function authorizeAttachment(env: Bindings, launch: ClassroomLaunch, token: string, sessionHash: string) {
  return authorize(classroomAuthorizationDependencies(env), launch, token, sessionHash);
}
