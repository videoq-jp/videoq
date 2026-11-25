import { pgTable, text, bigint, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './modern';
import type { AgentSkillState } from '../../persistence/contracts/agent-skill-repository';
export const agentSkills = pgTable('agent_skills', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  state: jsonb('state').$type<AgentSkillState>().notNull(),
  leaseToken: text('lease_token'), leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }),
  createdAt: text('created_at').notNull(),
}, table => [index('agent_skills_owner_idx').on(table.ownerId)]);
