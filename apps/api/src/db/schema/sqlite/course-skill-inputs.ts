import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { videoCourses } from './modern';

export const courseSkillInputs = sqliteTable('course_skill_inputs', {
  courseId: integer('course_id').primaryKey().references(() => videoCourses.id, { onDelete: 'cascade' }),
  generationEnabled: integer('generation_enabled').notNull().default(0),
  distributionEnabled: integer('distribution_enabled').notNull().default(0),
  policyVersion: text('policy_version').notNull().default('1'),
  language: text('language').notNull().default('ja'),
  revision: integer('revision').notNull().default(0),
  generationEpoch: integer('generation_epoch').notNull().default(0),
  observedInput: text('observed_input').notNull().default(''),
  nextCheckAt: integer('next_check_at').notNull().default(0),
}, table => [index('course_skill_inputs_due_idx').on(table.generationEnabled, table.nextCheckAt)]);

export const courseSkillBuilds = sqliteTable('course_skill_builds', {
  id: text('id').primaryKey(),
  courseId: integer('course_id').notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  inputKey: text('input_key').notNull(),
  input: text('input').notNull(),
  state: text('state').notNull().default('queued'),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
  generation: integer('generation').notNull().default(0),
  checkpoint: text('checkpoint').notNull().default(''),
  createdAt: integer('created_at').notNull(),
}, table => [uniqueIndex('course_skill_builds_input_idx').on(table.courseId, table.inputKey), index('course_skill_builds_queue_idx').on(table.state, table.leaseUntil)]);
