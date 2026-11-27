import { describe } from 'vitest';
import { createHash } from 'node:crypto';
import { postgresRateLimitBackend } from '../src/runtime/postgres-rate-limit';
import { isolatedPostgres } from './persistence/isolated-postgres';
import { rateLimitContract } from './contracts/rate-limit.contract';
const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('real PostgreSQL rate limiter', () => {
  rateLimitContract('PostgreSQL', async () => {
    const f = await isolatedPostgres(url!);
    try {
      await f.pool.query('CREATE TABLE runtime_rate_limits(key text PRIMARY KEY,history jsonb NOT NULL,window_sec integer NOT NULL,expires_at timestamptz NOT NULL)');
      const backend = postgresRateLimitBackend(f.pool);
      return { backend, age: async seconds => {
        await f.pool.query(`UPDATE runtime_rate_limits SET history=(SELECT jsonb_agg(CASE WHEN jsonb_typeof(e)='number' THEN to_jsonb((e::text)::float8-$1) ELSE jsonb_set(e,'{at}',to_jsonb((e->>'at')::float8-$1)) END ORDER BY ord) FROM jsonb_array_elements(history) WITH ORDINALITY AS a(e,ord))`, [seconds]);
      }, seedLegacy: async () => {
        await f.pool.query("INSERT INTO runtime_rate_limits VALUES($1,jsonb_build_array(EXTRACT(EPOCH FROM clock_timestamp())::float8),3600,now()+interval '1 hour')",[createHash('sha256').update('shared').digest('hex')]);
      }, dispose: f.dispose };
    } catch (error) { await f.dispose(); throw error; }
  });
});
