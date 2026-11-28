import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { users, videos } from './modern';
export const courseSkillKnowledgeChunks = sqliteTable('course_skill_knowledge_chunks', {
  key: text('key').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  videoId: integer('video_id').notNull().references(() => videos.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
}, table => [index('course_skill_knowledge_owner_video_idx').on(table.ownerId, table.videoId)]);
