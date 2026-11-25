import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { users } from './modern';
import type { StoredSkillState } from '../../../persistence/agent-skill-state';
export const agentSkills = sqliteTable('agent_skills', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  state: text('state', { mode: 'json' }).$type<StoredSkillState>().notNull(),
  leaseToken: text('lease_token'), leaseExpiresAt: integer('lease_expires_at'),
  createdAt: text('created_at').notNull(),
}, table => [index('agent_skills_owner_idx').on(table.ownerId)]);

export const agentSkillStateParts = sqliteTable('agent_skill_state_parts', {
  skillId: text('skill_id').notNull().references(() => agentSkills.id, { onDelete: 'cascade' }),
  revision: text('revision').notNull(), part: integer('part').notNull(), content: text('content').notNull(),
}, table => [primaryKey({ columns: [table.skillId, table.revision, table.part] })]);
