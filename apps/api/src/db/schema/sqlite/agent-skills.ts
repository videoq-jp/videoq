import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { users } from './modern';
import type { AgentSkillState } from '../../../persistence/contracts/agent-skill-repository';
export const agentSkills = sqliteTable('agent_skills', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  state: text('state', { mode: 'json' }).$type<AgentSkillState>().notNull(),
  leaseToken: text('lease_token'), leaseExpiresAt: integer('lease_expires_at'),
  createdAt: text('created_at').notNull(),
}, table => [index('agent_skills_owner_idx').on(table.ownerId)]);
