import { URL } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("answer quota migration", () => {
  it("raises usable plan quotas without changing overrides, usage, or other entitlements", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `answer_quota_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}";
        CREATE TABLE users (
          id text PRIMARY KEY, plan_code text, subscription_status text,
          quota_source text, ai_answers_limit integer, used_ai_answers integer DEFAULT 499,
          processing_limit_minutes integer DEFAULT 300, used_processing_seconds integer DEFAULT 120,
          storage_limit_gb integer DEFAULT 20, used_storage_bytes bigint DEFAULT 1024,
          updated_at timestamptz DEFAULT '2026-09-01T00:00:00Z'
        );
        INSERT INTO users (id, plan_code, subscription_status, quota_source, ai_answers_limit) VALUES
          ('basic', 'basic', 'active', 'plan', 500),
          ('pro', 'pro', 'trialing', 'plan', 2500),
          ('past_due', 'pro', 'past_due', 'plan', 2500),
          ('canceled', 'pro', 'canceled', 'plan', 30),
          ('unpaid', 'basic', 'unpaid', 'plan', 30),
          ('free', 'free', NULL, 'plan', 30),
          ('admin', 'pro', 'active', 'admin', 987),
          ('unlimited', 'pro', 'active', 'admin', NULL);
      `);
      const before = (await client.query("SELECT * FROM users ORDER BY id")).rows;
      const migration = readFileSync(new URL("../drizzle/0027_raise_ai_answers_without_evaluation.sql", import.meta.url), "utf8");
      await client.query(migration);
      const after = (await client.query("SELECT * FROM users ORDER BY id")).rows;
      for (let i = 0; i < before.length; i++) {
        if (["basic", "pro", "past_due"].includes(before[i].id)) {
          expect(after[i]).toEqual({ ...before[i],
            ai_answers_limit: before[i].plan_code === "basic" ? 1800 : 2800,
            updated_at: expect.any(Date),
          });
          expect(after[i].updated_at.getTime()).toBeGreaterThan(before[i].updated_at.getTime());
        } else expect(after[i]).toEqual(before[i]);
      }
      await client.query(migration);
      expect((await client.query("SELECT * FROM users ORDER BY id")).rows).toEqual(after);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
