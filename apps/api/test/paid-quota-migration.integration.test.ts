import { URL } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("paid quota tightening migration", () => {
  it("applies both limits without changing usage or administrator overrides", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `paid_quota_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}";
        CREATE TABLE users (
          id text PRIMARY KEY, plan_code text, subscription_status text,
          quota_source text, processing_limit_minutes integer, ai_answers_limit integer,
          used_processing_seconds integer DEFAULT 0, used_ai_answers integer DEFAULT 0,
          storage_limit_gb integer DEFAULT 20, monthly_upload_limit_gb integer DEFAULT 200,
          updated_at timestamptz DEFAULT '2026-09-01T00:00:00Z'
        );
        INSERT INTO users (id, plan_code, subscription_status, quota_source,
          processing_limit_minutes, ai_answers_limit, used_processing_seconds, used_ai_answers) VALUES
          ('basic', 'basic', 'active', 'plan', 300, 1800, 18000, 700),
          ('pro', 'pro', 'trialing', 'plan', 1500, 2800, 63000, 2200),
          ('past_due', 'pro', 'past_due', 'plan', 1500, 2800, 0, 0),
          ('canceled', 'pro', 'canceled', 'plan', 45, 30, 0, 0),
          ('free', 'free', NULL, 'plan', 45, 30, 0, 0),
          ('admin', 'pro', 'active', 'admin', 2500, 987, 0, 0);
      `);
      const before = (await client.query("SELECT * FROM users ORDER BY id")).rows;
      const migration = readFileSync(new URL("../drizzle/0035_tighten_paid_plan_quotas.sql", import.meta.url), "utf8");
      await client.query(migration);
      const after = (await client.query("SELECT * FROM users ORDER BY id")).rows;
      for (let i = 0; i < before.length; i++) {
        const row = before[i];
        const limits = row.id === "basic"
          ? { processing_limit_minutes: 200, ai_answers_limit: 500 }
          : ["pro", "past_due"].includes(row.id)
            ? { processing_limit_minutes: 1000, ai_answers_limit: 2000 }
            : null;
        expect(after[i]).toEqual(limits
          ? { ...row, ...limits, updated_at: expect.any(Date) }
          : row);
        if (limits) expect(after[i].updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
      }
      await client.query(migration);
      expect((await client.query("SELECT * FROM users ORDER BY id")).rows).toEqual(after);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
