import { createSqlCourseSkillInputRepository, type SkillSqlDriver } from '../course-skill-input-sql';

export function createD1SkillSqlDriver(database: D1Database): SkillSqlDriver {
  return {
    dialect: 'd1',
    all: async <T>(sql: string, values: (string | number | null)[]) => (await database.prepare(sql).bind(...values).all<T>()).results,
    batch: async statements => {
      const prepared = statements.map(s => database.prepare(s.sql).bind(...s.values));
      return (await database.batch(prepared)).map(r => r.results);
    },
  };
}
export function createD1CourseSkillInputRepository(database: D1Database) {
  return createSqlCourseSkillInputRepository(createD1SkillSqlDriver(database));
}
