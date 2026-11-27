import type { Bindings } from '../types/bindings';
import { persistenceBackend } from '../persistence/backend';
import { createSqlCourseSkillExecutionRepository } from '../persistence/course-skill-execution-sql';
export async function createCourseSkillExecutionRepository(env: Bindings) {
  if (persistenceBackend(env) === 'd1') {
    if (!env.DB) throw new Error('D1 DB binding is required');
    const { createD1SkillSqlDriver } = await import('../persistence/d1/course-skill-input-repository');
    return createSqlCourseSkillExecutionRepository(createD1SkillSqlDriver(env.DB));
  }
  const { createPostgresSkillSqlDriver } = await import('../persistence/postgres/course-skill-input-repository');
  return createSqlCourseSkillExecutionRepository(createPostgresSkillSqlDriver(env));
}
