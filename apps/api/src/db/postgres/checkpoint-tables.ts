import {
  pgSchema,
  text,
  jsonb,
  integer,
  customType,
} from "drizzle-orm/pg-core";
// Read-side mappings for tables managed by PostgresSaver's migrations. Keep
// these outside the application migration schema; this adapter does not own DDL.
const memory = pgSchema("chat_memory");
const bytes = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
export const memoryCheckpoints = memory.table("checkpoints", {
  threadId: text("thread_id").notNull(),
  namespace: text("checkpoint_ns").notNull(),
  checkpointId: text("checkpoint_id").notNull(),
  parentId: text("parent_checkpoint_id"),
  checkpoint: jsonb("checkpoint").notNull(),
  metadata: jsonb("metadata").notNull(),
});
export const memoryBlobs = memory.table("checkpoint_blobs", {
  threadId: text("thread_id").notNull(),
  namespace: text("checkpoint_ns").notNull(),
  channel: text("channel").notNull(),
  version: text("version").notNull(),
  type: text("type").notNull(),
  blob: bytes("blob"),
});
export const memoryWrites = memory.table("checkpoint_writes", {
  threadId: text("thread_id").notNull(),
  namespace: text("checkpoint_ns").notNull(),
  checkpointId: text("checkpoint_id").notNull(),
  taskId: text("task_id").notNull(),
  index: integer("idx").notNull(),
  channel: text("channel").notNull(),
  type: text("type"),
  blob: bytes("blob").notNull(),
});
