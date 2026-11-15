import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * D1 adapter-local guards. A business batch captures its authorized row here,
 * gates subsequent writes on the random token, and deletes the guard before
 * committing. No receipt survives a successful batch or a rolled-back batch.
 */
export const mutationReceipts = sqliteTable("mutation_receipts", {
  token: text("token").primaryKey(),
  kind: text("kind").notNull(),
  resourceId: integer("resource_id").notNull(),
  effectApplied: integer("effect_applied", { mode: "boolean" }).notNull().default(false),
});
