import type { Context } from 'hono';
import type { AppEnv } from '../../types/bindings';
import { courseSkillManagement, CourseSkillManagementError } from '../../integrations/course-skill-management';
import { requireUserId, rpcError, type HandlersFor } from './shared';

export function courseSkillHandlers(c: Context<AppEnv>, authenticatedUserId: string | null): HandlersFor<'courseSkills'> {
  const service = () => courseSkillManagement(c.env, requireUserId(authenticatedUserId));
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof CourseSkillManagementError) return rpcError(error.kind === 'not_found' ? 'NOT_FOUND' : error.kind === 'conflict' ? 'CONFLICT' : 'BAD_REQUEST', error.message);
      return rpcError('INTERNAL_SERVER_ERROR', 'Could not complete Skills operation');
    }
  }
  return {
    'courseSkills.list': input => run(() => service().list(input.courseId)),
    'courseSkills.get': input => run(() => service().get(input.courseId, input.candidateId)),
    'courseSkills.configure': input => run(() => service().configure(input.courseId, input.settings)),
    'courseSkills.rebuild': input => run(() => service().rebuild(input.courseId)),
    'courseSkills.update': input => run(() => service().update(input.courseId, input.candidateId, input.expectedHash, input.draft)),
    'courseSkills.publish': input => run(() => service().publish(input.courseId, input.candidateId, input.expectedHash)),
    'courseSkills.reject': input => run(() => service().reject(input.courseId, input.candidateId, input.expectedHash)),
    'courseSkills.withdraw': input => run(() => service().withdraw(input.courseId, input.skillId)),
  };
}
