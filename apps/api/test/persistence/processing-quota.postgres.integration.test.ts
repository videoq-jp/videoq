import { describe } from "vitest";
import { isolatedPostgres } from "./isolated-postgres";
import { processingQuotaContract } from "./contracts/processing-quota.contract";
import { createPostgresProcessingQuotaRepository } from "../../src/persistence/postgres/processing-quota";
import type { Bindings } from "../../src/types/bindings";
const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)("PostgreSQL processing quota", () => {
  processingQuotaContract("postgres", async () => {
    const f = await isolatedPostgres(url!);
    const execute = async (sql: string, args: unknown[] = []) => {
      let index = 0;
      await f.pool.query(sql.replaceAll("?", () => `$${++index}`), args);
    };
    await execute(`CREATE TABLE users(id text PRIMARY KEY,is_over_quota boolean NOT NULL,used_ai_answers integer NOT NULL,
      used_processing_seconds bigint NOT NULL,processing_limit_minutes integer,usage_period_start timestamptz)`);
    await execute("CREATE TABLE videos(id integer PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),processing_seconds integer NOT NULL DEFAULT 0)");
    await execute("INSERT INTO users VALUES ('owner',false,7,0,1,now())");
    await execute("INSERT INTO videos(id,user_id) SELECT generate_series(1,8),'owner'");
    return {
      repository: createPostgresProcessingQuotaRepository({ DATABASE_POOL: f.pool } as Bindings), execute, dispose: f.dispose,
      used: async () => {
        const row = (await f.pool.query<{ seconds: string; answers: number }>("SELECT used_processing_seconds AS seconds,used_ai_answers AS answers FROM users WHERE id='owner'")).rows[0];
        return { seconds: Number(row.seconds), answers: row.answers };
      },
      failVideoUpdate: async () => { await execute("ALTER TABLE videos ADD CONSTRAINT injected_failure CHECK(processing_seconds<>13)"); },
    };
  });
});
