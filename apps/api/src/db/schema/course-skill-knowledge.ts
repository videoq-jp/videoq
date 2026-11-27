import { pgTable, text, bigint, index } from 'drizzle-orm/pg-core';
import { users, videos } from './modern';
export const courseSkillKnowledgeChunks = pgTable('course_skill_knowledge_chunks', {
  key: text('key').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  videoId: bigint('video_id', { mode: 'number' }).notNull().references(() => videos.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
}, table => [index('course_skill_knowledge_owner_video_idx').on(table.ownerId, table.videoId)]);
