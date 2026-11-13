import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
/** Deliberately no FK: unfinished PUT cleanup survives video/run deletion. */
export const visualObjectAttempts = sqliteTable("visual_object_attempts", {
  id:text("id").primaryKey(),kind:text("kind",{enum:["chunk","manifest"]}).notNull(),
  videoId:integer("video_id").notNull(),runId:text("run_id").notNull(),fileKey:text("file_key").notNull(),
  chunkIndex:integer("chunk_index"),objectVersion:text("object_version").notNull(),
  status:text("status",{enum:["pending","published","deleting","cleaned"]}).notNull().default("pending"),
  expiresAt:text("expires_at").notNull(),availableAt:text("available_at").notNull(),
  leaseToken:text("lease_token"),leaseUntil:text("lease_until"),attempts:integer("attempts").notNull().default(0),
  lastErrorCode:text("last_error_code").notNull().default(""),createdAt:text("created_at").notNull().default(now),
},table=>[index("visual_object_attempts_due_idx").on(table.status,table.availableAt)]);
