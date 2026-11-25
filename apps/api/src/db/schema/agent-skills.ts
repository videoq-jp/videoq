import { pgTable, text, bigint, integer, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './modern';
import type { StoredSkillState } from '../../persistence/agent-skill-state';
export const agentSkills = pgTable('agent_skills', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  state: jsonb('state').$type<StoredSkillState>().notNull(),
  leaseToken: text('lease_token'), leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }),
  createdAt: text('created_at').notNull(),
}, table => [index('agent_skills_owner_idx').on(table.ownerId)]);

export const agentSkillStateParts = pgTable('agent_skill_state_parts', {
  skillId: text('skill_id').notNull().references(() => agentSkills.id, { onDelete: 'cascade' }),
  revision: text('revision').notNull(), part: integer('part').notNull(), content: text('content').notNull(),
}, table => [primaryKey({ columns: [table.skillId, table.revision, table.part] })]);
