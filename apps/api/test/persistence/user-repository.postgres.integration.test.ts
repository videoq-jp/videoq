import { describe, expect, it } from 'vitest';
import { getCurrentUser } from '../../src/persistence/postgres/user-repository';
import type { Bindings } from '../../src/types/bindings';
import { isolatedPostgres } from './isolated-postgres';

const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)('PostgreSQL account summary', () => {
  it('projects account entitlements while using the current UTC usage month', async () => {
    const { pool, dispose } = await isolatedPostgres(databaseUrl!);
    try {
      await pool.query(`CREATE TABLE users (
        id text PRIMARY KEY, username text, email text, role text, used_upload_bytes bigint,
        upload_usage_period_start timestamptz, monthly_upload_limit_gb double precision,
        used_storage_bytes bigint, storage_limit_gb double precision, used_processing_seconds integer,
        processing_limit_minutes double precision, used_ai_answers integer, ai_answers_limit integer,
        is_over_quota boolean, plan_code text, subscription_status text, quota_source text
      ); CREATE TABLE videos(id integer, user_id text);
      INSERT INTO users VALUES ('owner','owner','owner@example.test','user,admin',123,
        date_trunc('month',now(),'UTC'),NULL,42,1.5,60,90,3,NULL,false,'pro','active','admin');
      INSERT INTO videos VALUES (1,'owner'),(2,'other');`);
      const env = { DATABASE_POOL: pool } as Bindings;
      expect(await getCurrentUser(env, 'missing')).toBeNull();
      expect(await getCurrentUser(env, 'owner')).toMatchObject({
        id: 'owner', is_admin: true, video_count: 1, used_upload_bytes: 123, used_storage_bytes: 42,
        storage_limit_bytes: 1.5 * 1024 ** 3, processing_limit_seconds: 5400,
        monthly_upload_limit_bytes: null, ai_answers_limit: null, plan_code: 'pro', quota_source: 'admin',
      });
      await pool.query(`UPDATE users SET role='administrator',plan_code='basic',quota_source='plan',
        monthly_upload_limit_gb=0,storage_limit_gb=0,processing_limit_minutes=0,
        upload_usage_period_start='2000-01-01' WHERE id='owner'`);
      const current = await getCurrentUser(env, 'owner');
      expect(current).toMatchObject({ is_admin: false, plan_code: 'basic', quota_source: 'plan',
        monthly_upload_limit_bytes: 0, storage_limit_bytes: 0, processing_limit_seconds: 0, used_upload_bytes: 0 });
      expect(current?.upload_resets_at).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    } finally { await dispose(); }
  });
});
