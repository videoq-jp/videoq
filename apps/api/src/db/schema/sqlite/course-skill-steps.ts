import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { courseSkillBuilds } from './course-skill-inputs';
export const courseSkillSteps = sqliteTable('course_skill_steps', {
  key: text('key').primaryKey(),
  buildId: text('build_id').notNull().references(() => courseSkillBuilds.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
}, table => [index('course_skill_steps_build_idx').on(table.buildId)]);
