import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { videos } from './modern';
/** Facts start only at a new accepted revision; historical timestamps are not backfilled. */
export const policyReadiness = sqliteTable('policy_readiness', {
  videoId: integer('video_id').primaryKey().references(()=>videos.id,{onDelete:'cascade'}),
  sourceRevision: text('source_revision').notNull(), transcriptAcceptedAt: text('transcript_accepted_at').notNull(), readyAt: text('ready_at'),
});
export const policyCleanup = sqliteTable('policy_cleanup', {
  id: text('id').primaryKey().notNull(), scope: text('scope').notNull(), taskId:text('task_id').notNull(),
  logicalDeletedAt: text('logical_deleted_at').notNull(), completedAt: text('completed_at'),
},table=>[check('policy_cleanup_scope_check',sql`${table.scope} IN ('active-object','active-index')`)]);
export const policyNotifications = sqliteTable('policy_notifications', {
  id: text('id').primaryKey().notNull(), severity:text('severity').notNull(),state:text('state').notNull().default('pending'),
  attempts:integer('attempts').notNull().default(0),leaseUntil:text('lease_until'),deliveredAt:text('delivered_at'),
  createdAt:text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});
