import { URL } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("transcription allowance migration", () => {
  it("raises eligible plan limits while preserving overrides and usage", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `transcription_quota_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}";
        CREATE TABLE users (
          id text PRIMARY KEY, plan_code text, subscription_status text,
          quota_source text, processing_limit_minutes integer, ai_answers_limit integer,
          used_processing_seconds integer DEFAULT 0, is_over_quota boolean DEFAULT false,
          updated_at timestamptz DEFAULT '2026-09-01T00:00:00Z'
        );
        INSERT INTO users (id, plan_code, subscription_status, quota_source,
          processing_limit_minutes, ai_answers_limit, used_processing_seconds, is_over_quota) VALUES
          ('free', 'free', NULL, 'plan', 45, 30, 2500, false),
          ('basic', 'basic', 'active', 'plan', 200, 500, 12000, false),
          ('pro', 'pro', 'trialing', 'plan', 1000, 2000, 62000, true),
          ('past_due', 'pro', 'past_due', 'plan', 1000, 2000, 0, false),
          ('canceled', 'pro', 'canceled', 'plan', 45, 30, 0, false),
          ('admin', 'basic', 'active', 'admin', 0, 987, 3000, false);
      `);
      const before = (await client.query("SELECT * FROM users ORDER BY id")).rows;
      const migration = readFileSync(new URL("../drizzle/0038_raise_transcription_allowances.sql", import.meta.url), "utf8");
      await client.query(migration);
      const after = (await client.query("SELECT * FROM users ORDER BY id")).rows;
      for (let i = 0; i < before.length; i++) {
        const row = before[i];
        const newLimit = row.id === "free" ? 120 : row.id === "basic" ? 500
          : ["pro", "past_due"].includes(row.id) ? 1500 : null;
        expect(after[i]).toEqual(newLimit === null ? row : {
          ...row,
          processing_limit_minutes: newLimit,
          updated_at: expect.any(Date),
        });
        if (newLimit !== null) expect(after[i].updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
      }
      await client.query(migration);
      expect((await client.query("SELECT * FROM users ORDER BY id")).rows).toEqual(after);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
