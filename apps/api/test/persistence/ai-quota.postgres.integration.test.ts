import {describe} from "vitest";
import {isolatedPostgres} from "./isolated-postgres";
import {aiQuotaContract} from "./contracts/ai-quota.contract";
import {createPostgresAiQuotaRepository} from "../../src/persistence/postgres/ai-quota";
import {createPostgresProcessingQuotaRepository} from "../../src/persistence/postgres/processing-quota";
import type {Bindings} from "../../src/types/bindings";
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL AI quota',()=>{
  aiQuotaContract('postgres',async()=>{
    const f=await isolatedPostgres(url!);const env={DATABASE_POOL:f.pool} as Bindings;
    const execute=async(sql:string,args:unknown[]=[])=>{let index=0;await f.pool.query(sql.replaceAll('?',()=>`$${++index}`),args);};
    await execute(`CREATE TABLE users(id text PRIMARY KEY,is_over_quota boolean,ai_answers_limit integer,used_ai_answers integer,used_processing_seconds integer,
      usage_period_start timestamptz,plan_code text,quota_source text,processing_limit_minutes integer,used_upload_bytes bigint)`);
    await execute("CREATE TABLE videos(id integer PRIMARY KEY,user_id text REFERENCES users(id),processing_seconds integer DEFAULT 0)");
    await execute("INSERT INTO users VALUES ('owner',false,3,0,0,now(),'basic','admin',NULL,55)");
    await execute("INSERT INTO videos(id,user_id) VALUES (1,'owner')");
    return {ai:createPostgresAiQuotaRepository(env),processing:createPostgresProcessingQuotaRepository(env),execute,
      usage:async()=>{const row=(await f.pool.query<{answers:number;processing:number;uploads:string}>('SELECT used_ai_answers AS answers,used_processing_seconds AS processing,used_upload_bytes AS uploads FROM users')).rows[0];return {...row,uploads:Number(row.uploads)};},dispose:f.dispose};
  });
});
