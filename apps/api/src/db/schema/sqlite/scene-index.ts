import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey, index, check, uniqueIndex } from "drizzle-orm/sqlite-core";
import { videos } from "./modern";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** A source fence changes whenever the authoritative transcript/media changes. */
export const videoIndexVersions = sqliteTable("video_index_versions", {
  videoId: integer("video_id").primaryKey().references(() => videos.id, { onDelete: "cascade" }),
  revision: text("revision").notNull(),
});

/** Staged runs let long videos be uploaded in bounded, retryable chunks. */
export const sceneIndexRuns = sqliteTable("scene_index_runs", {
  id: text("id").primaryKey(),
  videoId: integer("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  sourceRevision: text("source_revision").notNull(),
  dimensions: integer("dimensions").notNull(),
  expectedScenes: integer("expected_scenes").notNull(),
  status: text("status", { enum: ["staging", "published"] }).notNull().default("staging"),
  createdAt: text("created_at").notNull().default(now),
}, table => [index("scene_index_runs_video_idx").on(table.videoId),
  check("scene_index_runs_dimensions_check", sql`${table.dimensions} IN (768,1536)`),
  check("scene_index_runs_count_check", sql`${table.expectedScenes} >= 0`)]);

export const videoIndexHeads = sqliteTable("video_index_heads", {
  videoId: integer("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  dimensions: integer("dimensions").notNull(),
  runId: text("run_id").notNull(),
}, table => [primaryKey({ columns: [table.videoId, table.dimensions] })]);

export const sceneStaging = sqliteTable("scene_staging", {
  runId: text("run_id").notNull().references(() => sceneIndexRuns.id, { onDelete: "cascade" }),
  sceneId: text("scene_id").notNull(),
  vectorId: text("vector_id").notNull(),
  content: text("content").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  evidenceType: text("evidence_type", { enum: ["transcript", "visual"] }).notNull(),
}, table => [primaryKey({ columns: [table.runId, table.sceneId] }),
  uniqueIndex("scene_staging_vector_idx").on(table.vectorId)]);

/** No foreign keys: delete work must survive deletion of its source video/run. */
export const sceneIndexTasks = sqliteTable("scene_index_tasks", {
  id: text("id").primaryKey(),
  operation: text("operation", { enum: ["upsert", "delete"] }).notNull(),
  vectorId: text("vector_id").notNull(),
  sceneId: text("scene_id").notNull(),
  revision: text("revision").notNull(),
  videoId: integer("video_id").notNull(),
  userId: text("user_id").notNull(),
  dimensions: integer("dimensions").notNull(),
  embedding: text("embedding", { mode: "json" }).$type<number[]>(),
  attempts: integer("attempts").notNull().default(0),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
  availableAt: text("available_at").notNull().default(now),
  completedAt: text("completed_at"),
  verifiedAt: text("verified_at"),
  lastErrorCode: text("last_error_code").notNull().default(""),
  createdAt: text("created_at").notNull().default(now),
}, table => [index("scene_index_tasks_ready_idx").on(table.completedAt, table.availableAt),
  check("scene_index_tasks_dimensions_check", sql`${table.dimensions} IN (768,1536)`),
  check("scene_index_tasks_operation_check", sql`${table.operation} IN ('upsert','delete')`)]);
