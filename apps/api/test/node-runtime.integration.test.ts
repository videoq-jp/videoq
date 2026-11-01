import { URL } from "node:url";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeBindings } from "../src/runtime/node-config";
import { createNodeApp } from "../src/runtime/node-app";
import { postgresRateLimitBackend } from "../src/runtime/postgres-rate-limit";

const databaseURL = process.env.QUOTA_TEST_DATABASE_URL;
const withPostgres = databaseURL ? describe : describe.skip;

withPostgres("on-prem runtime with PostgreSQL", () => {
  const schema = `onprem_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let second: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseURL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(readFileSync(new URL("../drizzle/0039_onprem_rate_limits.sql", import.meta.url), "utf8"));
    const url = new URL(databaseURL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
    second = new pg.Pool({ connectionString: url.toString(), max: 5 });
  });
  afterAll(async () => {
    await Promise.all([pool.end(), second.end()]);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("allows exactly the limit across racing replicas and stores only hashed keys", async () => {
    const replicas = [postgresRateLimitBackend(pool), postgresRateLimitBackend(second)];
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      replicas[i % 2].consume("user@example.edu", 7, 60)));
    expect(results.filter(result => result.allowed)).toHaveLength(7);
    expect(results.filter(result => !result.allowed).every(result => result.retryAfterSec > 0)).toBe(true);
    expect(await replicas[1].snapshot("user@example.edu")).toMatchObject({ count: 7 });
    const { rows } = await admin.query("SELECT key FROM runtime_rate_limits");
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports atomic multi-cost consumption, compensation, expiration and restart", async () => {
    const first = postgresRateLimitBackend(pool);
    expect((await first.consume("batch", 3, 60, 2)).allowed).toBe(true);
    expect((await first.consume("batch", 3, 60, 2)).allowed).toBe(false);
    await postgresRateLimitBackend(second).release("batch", 60, 2);
    expect((await first.consume("batch", 3, 60, 3)).allowed).toBe(true);
    await admin.query("UPDATE runtime_rate_limits SET history = '[1, 0]'::jsonb, expires_at = now() - interval '1 second'");
    expect(await first.snapshot("batch")).toBeNull();
    await Promise.all([
      admin.query("DELETE FROM runtime_rate_limits WHERE expires_at <= now()"),
      ...Array.from({ length: 10 }, () => first.consume("batch", 2, 60)),
    ]);
    expect(await first.snapshot("batch")).toMatchObject({ count: 2 });
  });

  it("serves readiness through a shared Node pool and exposes normal HTTP routes", async () => {
    const env = nodeBindings({ DATABASE_URL: databaseURL, BETTER_AUTH_URL: "https://videoq.example.edu",
      BETTER_AUTH_SECRET: "a".repeat(48), USER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
      R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_S3_ENDPOINT: "https://s3.example.edu",
      R2_BUCKET_NAME: "media", SQS_QUEUE_URL: "http://queue:9324/test",
      AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" });
    env.DATABASE_POOL = pool;
    env.RATE_LIMIT_BACKEND = postgresRateLimitBackend(pool);
    const app = createNodeApp(env);
    const response = await app.fetch(new Request("https://videoq.example.edu/ready"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: "ready", db: "ok" } });
    const health = await app.fetch(new Request("https://videoq.example.edu/health"));
    expect(health.status).toBe(200);
    await app.drain();
    expect(pool.waitingCount).toBe(0);
  });
});
