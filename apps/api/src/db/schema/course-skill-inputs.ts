import { pgTable, bigint, text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { videoCourses } from './modern';

/** A durable reconciliation cursor. Defaults never enable paid generation. */
export const courseSkillInputs = pgTable('course_skill_inputs', {
  courseId: bigint('course_id', { mode: 'number' }).primaryKey().references(() => videoCourses.id, { onDelete: 'cascade' }),
  generationEnabled: integer('generation_enabled').notNull().default(0),
  distributionEnabled: integer('distribution_enabled').notNull().default(0),
  policyVersion: text('policy_version').notNull().default('1'),
  language: text('language').notNull().default('ja'),
  revision: integer('revision').notNull().default(0),
  observedInput: text('observed_input').notNull().default(''),
  nextCheckAt: bigint('next_check_at', { mode: 'number' }).notNull().default(0),
}, table => [index('course_skill_inputs_due_idx').on(table.generationEnabled, table.nextCheckAt)]);

/** Immutable input envelope; large extraction results live outside this row. */
export const courseSkillBuilds = pgTable('course_skill_builds', {
  id: text('id').primaryKey(),
  courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => videoCourses.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  inputKey: text('input_key').notNull(),
  input: text('input').notNull(),
  state: text('state').notNull().default('queued'),
  leaseToken: text('lease_token'),
  leaseUntil: bigint('lease_until', { mode: 'number' }).notNull().default(0),
  generation: integer('generation').notNull().default(0),
  checkpoint: text('checkpoint').notNull().default(''),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, table => [uniqueIndex('course_skill_builds_input_idx').on(table.courseId, table.inputKey), index('course_skill_builds_queue_idx').on(table.state, table.leaseUntil)]);
