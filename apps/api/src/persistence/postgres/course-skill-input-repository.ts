import { withClient } from '../../db/pool';
import type { Bindings } from '../../types/bindings';
import { createSqlCourseSkillInputRepository, type SkillSqlDriver } from '../course-skill-input-sql';

/** Only generated SQL contains placeholders; no user text is interpolated. */
const placeholders = (sql: string) => { let index = 0; return sql.replaceAll('?', () => `$${++index}`); };
export function createPostgresSkillSqlDriver(env: Bindings): SkillSqlDriver {
  return {
    dialect: 'postgres',
    all: <T>(sql: string, values: (string | number | null)[]) => withClient(env, async client => (await client.query(placeholders(sql), values)).rows as T[]),
    batch: statements => withClient(env, async client => {
      await client.query('BEGIN');
      try {
        const results: unknown[][] = [];
        for (const statement of statements) results.push((await client.query(placeholders(statement.sql), statement.values)).rows);
        await client.query('COMMIT');
        return results;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }),
  };
}
export function createPostgresCourseSkillInputRepository(env: Bindings) {
  return createSqlCourseSkillInputRepository(createPostgresSkillSqlDriver(env));
}
