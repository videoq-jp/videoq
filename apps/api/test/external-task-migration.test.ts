import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0010_external_tasks.sql", import.meta.url),
  "utf8",
);

describe("external task outbox migration", () => {
  it("stores deduplicated retry and effect-application state", () => {
    expect(migration).toContain('CREATE TABLE "external_tasks"');
    expect(migration).toContain(
      'CONSTRAINT "external_tasks_dedupe_key_key" UNIQUE("dedupe_key")',
    );
    expect(migration).toContain('"effect_applied_at" timestamp with time zone');
    expect(migration).toContain("WHERE completed_at IS NULL");
  });

  it("uses the exact PostgreSQL bigint identity maximum", () => {
    expect(migration).toContain("MAXVALUE 9223372036854775807");
    expect(migration).not.toContain("MAXVALUE 9223372036854776000");
  });
});
