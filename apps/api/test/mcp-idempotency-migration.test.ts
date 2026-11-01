import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/0018_better_auth_1_7_and_mcp_idempotency.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("MCP idempotency migration", () => {
  it("creates a user-scoped key ledger with bounded actions", () => {
    expect(migration).toContain('CREATE TABLE "mcp_idempotency_records"');
    expect(migration).toContain(
      'PRIMARY KEY("user_id","action","key")',
    );
    expect(migration).toContain(
      "action IN ('request_video_upload', 'create_youtube_video', 'create_course')",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade',
    );
  });

  it("stores a validated request fingerprint", () => {
    expect(migration).toContain('"request_hash" varchar(64) NOT NULL');
    expect(migration).toContain("request_hash ~ '^[0-9a-f]{64}$'");
  });
});
