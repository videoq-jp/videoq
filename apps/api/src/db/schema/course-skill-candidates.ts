import { pgTable, text, bigint, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { videoCourses } from './modern';
import { courseSkillBuilds } from './course-skill-inputs';
export const courseSkillCandidates = pgTable('course_skill_candidates', {
  id: text('id').primaryKey(),
  courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  buildId: text('build_id').notNull().references(() => courseSkillBuilds.id, { onDelete: 'cascade' }),
  skillId: text('skill_id').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  status: text('status').notNull().default('review_required'),
  approvedHash: text('approved_hash'),
}, table => [uniqueIndex('course_skill_candidate_task_idx').on(table.buildId, table.skillId), index('course_skill_candidate_course_idx').on(table.courseId)]);
