import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0009_concurrency_guards.sql", import.meta.url),
  "utf8",
);

describe("concurrency guards migration", () => {
  it("adds idempotent processing reservations to videos", () => {
    expect(migration).toContain(
      'ADD COLUMN "processing_seconds" integer DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain(
      'CONSTRAINT "videos_processing_seconds_check" CHECK (processing_seconds >= 0)',
    );
  });
});
