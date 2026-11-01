import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const userIdMigration = readFileSync(
  new URL("../drizzle/0006_user_id_uuid.sql", import.meta.url),
  "utf8",
);
const courseRenameMigration = readFileSync(
  new URL("../drizzle/0016_rename_groups_to_courses.sql", import.meta.url),
  "utf8",
);

describe("course rename migration", () => {
  it("recreates the course owner index dropped by the user-id migration", () => {
    expect(userIdMigration).toContain(
      'ALTER TABLE "video_groups" DROP COLUMN "user_id"',
    );
    expect(courseRenameMigration).not.toContain(
      'ALTER INDEX "video_groups_user_id_idx"',
    );
    expect(courseRenameMigration).toContain(
      'CREATE INDEX "video_courses_user_id_idx" ON "video_courses"',
    );
  });
});
