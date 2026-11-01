import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0008_group_invitations.sql", import.meta.url),
  "utf8",
);

describe("group invitation migration", () => {
  it("uses an exact PostgreSQL bigint identity maximum", () => {
    expect(migration).not.toContain("MAXVALUE 9223372036854776000");
    expect(migration.match(/MAXVALUE 9223372036854775807/g)).toHaveLength(2);
  });
});
