import { describe } from "vitest";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { users } from "../../src/db/schema";
import * as authSchema from "../../src/db/schema/better-auth";
import { isolatedPostgres } from "./isolated-postgres";
import { oauthGrantContract } from "./contracts/oauth-grant.contract";
import type { Bindings } from "../../src/types/bindings";

const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)("PostgreSQL OAuth grant", () => {
  oauthGrantContract("PostgreSQL onprem", async () => {
    const f = await isolatedPostgres(url!);
    try {
      const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ users, ...authSchema }));
      await f.pool.query(statements.map(sql => sql.replaceAll('"public".', "")).join("\n"), []);
      const ids = async (table: string) => (await f.pool.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).rows.map(row => row.id);
      return {
        env: { DEPLOYMENT_EDITION: "onprem", DATABASE_POOL: f.pool } as Bindings,
        encodeArray: value => value,
        execute: async (sql, args = []) => { let index = 0; await f.pool.query(sql.replaceAll("?", () => `$${++index}`), args); },
        snapshot: async () => ({ consents: await ids("oauth_consent"), refresh: await ids("oauth_refresh_token"), access: await ids("oauth_access_token") }),
        failDeletion: async table => { await f.pool.query(`CREATE FUNCTION fail_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-secret-failure-canary'; END $$; CREATE TRIGGER fail_grant BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_grant()`); },
        clearFailure: async table => { await f.pool.query(`DROP TRIGGER fail_grant ON ${table}; DROP FUNCTION fail_grant()`); },
        dispose: f.dispose,
      };
    } catch (error) { await f.dispose(); throw error; }
  });
});
