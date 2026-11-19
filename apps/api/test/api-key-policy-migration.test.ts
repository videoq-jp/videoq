import { readFileSync } from "node:fs";
import pg from "pg";
import { expect, it } from "vitest";
import { createD1Fixture } from "./persistence/d1-fixture";

const cases = [
  ["default", "default", true, true, 10, 86400000, true],
  ["writer", "read-write", true, true, 10, 86400000, true],
  ["custom-count", "default", true, true, 25, 86400000, false],
  ["custom-window", "default", true, true, 10, 60000, false],
  ["rate-disabled", "default", true, false, 10, 86400000, false],
  ["key-disabled", "default", false, true, 10, 86400000, false],
  ["other-config", "custom", true, true, 10, 86400000, false],
] as const;
function check(rows: { id: string; rate_limit_max: number; rate_limit_time_window: number; request_count: number }[]) {
  for (const [id, , , , max, window, migrated] of cases) {
    expect(rows.find(row => row.id === id)).toMatchObject({ rate_limit_max: migrated ? 1200 : max,
      rate_limit_time_window: migrated ? 3600000 : window, request_count: migrated ? 0 : 7 });
  }
}

it("upgrades only legacy default API-key budgets in D1, idempotently", async () => {
  const fixture = await createD1Fixture({ beforeMigration: "0020_api_key_request_budget.sql" });
  try {
    for (const [id, config, enabled, limited, max, window] of cases) await fixture.database.prepare(`INSERT INTO apikey
      (id,config_id,reference_id,key,enabled,rate_limit_enabled,rate_limit_max,rate_limit_time_window,request_count)
      VALUES (?,?, 'fixture',?, ?,?,?,?,7)`).bind(id,config,id,Number(enabled),Number(limited),max,window).run();
    const sql: string = readFileSync(new URL("../drizzle-d1/0020_api_key_request_budget.sql", import.meta.url), "utf8");
    for (let i = 0; i < 2; i++) {
      await fixture.database.prepare(sql).run();
      check((await fixture.database.prepare("SELECT * FROM apikey").all()).results as Parameters<typeof check>[0]);
    }
  } finally { await fixture.dispose(); }
});

it.skipIf(!process.env.QUOTA_TEST_DATABASE_URL)("upgrades the same legacy budgets in PostgreSQL", async () => {
  const client = new pg.Client({ connectionString: process.env.QUOTA_TEST_DATABASE_URL });
  const schema = `key_budget_${crypto.randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE apikey(id text PRIMARY KEY, config_id text, enabled boolean, rate_limit_enabled boolean,
        rate_limit_max integer, rate_limit_time_window integer, request_count integer, last_request timestamptz);`);
    for (const [id, config, enabled, limited, max, window] of cases) await client.query("INSERT INTO apikey VALUES ($1,$2,$3,$4,$5,$6,7,now())", [id,config,enabled,limited,max,window]);
    const sql: string = readFileSync(new URL("../drizzle/0066_api_key_request_budget.sql", import.meta.url), "utf8");
    for (let i = 0; i < 2; i++) { await client.query(sql); check((await client.query("SELECT * FROM apikey")).rows); }
  } finally { await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end(); }
});
