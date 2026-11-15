import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, check, primaryKey } from "drizzle-orm/sqlite-core";
import { videos } from "./modern";

/** D1 is the source of truth; Vectorize stores only vectors and filter metadata. */
export const scenes = sqliteTable("scenes", {
  id: text("id").notNull(),
  videoId: integer("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  evidenceType: text("evidence_type", { enum: ["transcript", "visual"] }).notNull().default("transcript"),
  dimensions: integer("dimensions").notNull(),
  revision: text("revision").notNull(),
  /** Null only for pre-migration vectors whose ID was the scene ID itself. */
  vectorId: text("vector_id"),
}, table => [
  primaryKey({ columns: [table.id, table.dimensions] }),
  index("scenes_video_idx").on(table.videoId),
  check("scenes_dimensions_check", sql`${table.dimensions} IN (768, 1536)`),
  check("scenes_evidence_type_check", sql`${table.evidenceType} IN ('transcript', 'visual')`),
  check("scenes_id_length_check", sql`length(CAST(${table.id} AS BLOB)) BETWEEN 1 AND 64`),
]);
