import { pgTable, text, bigint, integer, primaryKey, index } from 'drizzle-orm/pg-core';
import { videoCourses } from './modern';
import { courseSkillCandidates } from './course-skill-candidates';
export const courseSkillPublications = pgTable('course_skill_publications', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id').notNull().references(() => courseSkillCandidates.id, { onDelete: 'cascade' }),
  courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  skillId: text('skill_id').notNull(), name: text('name').notNull(), description: text('description').notNull(),
  contentHash: text('content_hash').notNull(), state: text('state').notNull().default('staged'),
  sources: text('sources').notNull(), manifest: text('manifest').notNull(),
}, table => [index('course_skill_publications_course_idx').on(table.courseId, table.skillId)]);
export const courseSkillHeads = pgTable('course_skill_heads', {
  courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  skillId: text('skill_id').notNull(),
  revisionId: text('revision_id').notNull().references(() => courseSkillPublications.id, { onDelete: 'cascade' }),
}, table => [primaryKey({ columns: [table.courseId, table.skillId] })]);
export const courseSkillFiles = pgTable('course_skill_files', {
  revisionId: text('revision_id').notNull().references(() => courseSkillPublications.id, { onDelete: 'cascade' }),
  path: text('path').notNull(), content: text('content').notNull(), digest: text('digest').notNull(), size: integer('size').notNull(),
}, table => [primaryKey({ columns: [table.revisionId, table.path] })]);
