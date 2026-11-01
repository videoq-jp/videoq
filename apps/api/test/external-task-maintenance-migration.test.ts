import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0011_job_delivery_guards.sql", import.meta.url),
  "utf8",
);

describe("job delivery guards migration", () => {
  it("adds dead-letter state to the outbox", () => {
    expect(migration).toContain('ADD COLUMN "dead_at" timestamp with time zone');
    expect(migration).toContain("dead_at IS NULL");
  });

  it("stores one leased execution per job_id", () => {
    expect(migration).toContain('CREATE TABLE "job_executions"');
    expect(migration).toContain('"job_id" varchar(128) PRIMARY KEY');
    expect(migration).toContain('"lease_token" varchar(36)');
    expect(migration).toContain("status IN ('running', 'failed', 'completed')");
  });
});
