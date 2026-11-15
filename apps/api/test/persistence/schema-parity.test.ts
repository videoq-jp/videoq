import { is, getTableName } from "drizzle-orm";
import { PgTable, getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import { SQLiteTable, getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import { expect, it } from "vitest";
import * as postgres from "../../src/db/schema";
import * as sqlite from "../../src/db/schema/sqlite";

it("preserves application table/column names and foreign-key relationships across dialects", () => {
  const pg = Object.values(postgres).filter(value => is(value, PgTable)).map(table => pgConfig(table));
  const d1 = new Map(Object.values(sqlite).filter(value => is(value, SQLiteTable)).map(table => {
    const config = sqliteConfig(table);
    return [config.name, config];
  }));
  for (const original of pg) {
    if (original.name === "scene_embeddings" || original.name === "scene_embeddings_768") continue;
    const counterpart = d1.get(original.name);
    expect(counterpart, original.name).toBeDefined();
    // D1 cannot hold a row lock through an R2 PUT. Its immutable object
    // pointer is adapter metadata; every application column still matches.
    // D1 billing uses a monotonic token instead of PG timestamp precision.
    const adapterColumns = original.name === "video_visual_chunks" ? ["object_version"]
      : original.name === "video_visual_runs" ? ["publication_version"]
      : original.name === "users" ? ["billing_revision"]
      : original.name === "video_course_invitations" ? ["creation_nonce"] : [];
    expect(counterpart!.columns.map(column => column.name).sort(), original.name)
      .toEqual([...original.columns.map(column => column.name), ...adapterColumns].sort());
    const references = (keys: typeof original.foreignKeys | NonNullable<typeof counterpart>["foreignKeys"]) => keys.map(key => {
      const ref = key.reference();
      return { columns: ref.columns.map(column => column.name), foreignColumns: ref.foreignColumns.map(column => column.name), foreignTable: getTableName(ref.foreignTable), onDelete: key.onDelete ?? "no action", onUpdate: key.onUpdate ?? "no action" };
    });
    expect(references(counterpart!.foreignKeys), original.name).toEqual(references(original.foreignKeys));
  }
});
