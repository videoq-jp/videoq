import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0003_langchain_pgvector.sql", import.meta.url),
  "utf8",
);

describe("langchain-postgres metadata_columns migration", () => {
  it("認可列をfilter可能なmetadata_columnsとして維持する", () => {
    const rename = migration.indexOf('RENAME COLUMN "id" TO "langchain_id"');
    const notNull = migration.indexOf('ALTER COLUMN "user_id" SET NOT NULL');
    const userIndex = migration.indexOf("scene_embeddings_user_id_idx");

    expect(rename).toBeGreaterThanOrEqual(0);
    expect(notNull).toBeGreaterThan(rename);
    expect(userIndex).toBeGreaterThan(notNull);
    expect(migration).not.toContain('DROP COLUMN "user_id"');
    expect(migration).not.toContain('DROP COLUMN "video_id"');
    expect(migration).not.toContain('DROP TABLE "scene_embeddings"');
  });
});
