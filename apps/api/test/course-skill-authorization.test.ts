import { describe, expect, it, vi } from 'vitest';
import { appRouter } from '@videoq/trpc';
import type { Bindings } from '../src/types/bindings';

const { ownedBy } = vi.hoisted(() => ({ ownedBy: vi.fn(async () => false) }));
vi.mock('../src/persistence/factory', () => ({ createCourseRepository: async () => ({ ownedBy }) }));
import { courseSkillManagement } from '../src/integrations/course-skill-management';

const settings = { generationEnabled: true, distributionEnabled: true, language: 'ja' as const, policyVersion: '1' };
describe('course skill management authorization', () => {
  it('rejects all unauthenticated procedures before invoking application code', async () => {
    const call = vi.fn();
    const caller = appRouter.createCaller({ userId: null, assertAdmin: async () => undefined, call });
    const requests = [caller.courseSkills.list({ courseId: 1 }), caller.courseSkills.get({ courseId: 1, candidateId: 'c' }), caller.courseSkills.configure({ courseId: 1, settings }), caller.courseSkills.rebuild({ courseId: 1 }), caller.courseSkills.publish({ courseId: 1, candidateId: 'c', expectedHash: 'a'.repeat(64) }), caller.courseSkills.reject({ courseId: 1, candidateId: 'c', expectedHash: 'a'.repeat(64) }), caller.courseSkills.withdraw({ courseId: 1, skillId: 's' })];
    for (const result of await Promise.allSettled(requests)) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'UNAUTHORIZED' });
    }
    expect(call).not.toHaveBeenCalled();
  });
  it('rejects an authenticated non-owner on every management operation', async () => {
    const service = courseSkillManagement({} as Bindings, 'outsider');
    const requests = [service.list(1), service.get(1, 'c'), service.configure(1, settings), service.rebuild(1), service.publish(1, 'c', 'hash'), service.reject(1, 'c', 'hash'), service.withdraw(1, 's')];
    for (const result of await Promise.allSettled(requests)) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ kind: 'not_found' });
    }
    expect(ownedBy).toHaveBeenCalledWith(1, 'outsider');
  });
});
