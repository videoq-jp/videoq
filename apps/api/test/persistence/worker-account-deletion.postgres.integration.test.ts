import { beforeAll,afterAll,beforeEach,describe,it,expect } from 'vitest';
import { isolatedPostgres } from './isolated-postgres';
import { createPostgresWorkerAccountDeletion } from '../../src/persistence/postgres/worker-account-deletion';
import type { Bindings } from '../../src/types/bindings';
const databaseUrl=process.env.PERSISTENCE_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('PostgreSQL leased account deletion',()=>{
  let fixture:Awaited<ReturnType<typeof isolatedPostgres>>;
  const grant={userId:'owner',jobId:'delete-job',leaseToken:'00000000-0000-4000-8000-000000000001'};
  const step=()=>createPostgresWorkerAccountDeletion({RUNTIME:'node',DATABASE_POOL:fixture.pool} as Bindings).step(grant);
  beforeAll(async()=>{
    fixture=await isolatedPostgres(databaseUrl!);
    await fixture.pool.query(`
      CREATE TABLE users(id text PRIMARY KEY,banned boolean,ban_expires timestamptz,role text,used_upload_bytes bigint DEFAULT 0,used_storage_bytes bigint DEFAULT 0,upload_usage_period_start timestamptz);
      CREATE TABLE job_executions(job_id text PRIMARY KEY,job_type text,status text,lease_token uuid,lease_until timestamptz);
      CREATE TABLE external_tasks(id bigserial PRIMARY KEY,kind text,payload jsonb,dedupe_key text UNIQUE,
        attempts int DEFAULT 0,available_at timestamptz DEFAULT now(),locked_at timestamptz,completed_at timestamptz,dead_at timestamptz,
        effect_applied_at timestamptz,last_error text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE videos(id bigint,user_id text,file text DEFAULT '',status text DEFAULT 'completed',multipart_upload jsonb,upload_heartbeat_at timestamptz,upload_usage_period_start timestamptz);
      CREATE TABLE mcp_idempotency_records(user_id text,resource_id bigint,action text);
      CREATE TABLE scene_embeddings(user_id text,video_id bigint,langchain_metadata json);
      CREATE TABLE scene_embeddings_768(user_id text);
      CREATE TABLE chat_logs(user_id text);
      CREATE TABLE video_courses(user_id text);
      CREATE TABLE tags(user_id text);
      CREATE TABLE apikey(reference_id text);
      CREATE TABLE lti_credentials(payload jsonb);
      CREATE TABLE lms_installations(id text,owner_user_id text REFERENCES users(id) ON DELETE CASCADE);
    `);
  });
  afterAll(async()=>{await fixture?.dispose();});
  beforeEach(async()=>{
    await fixture.pool.query('TRUNCATE users,job_executions,external_tasks,videos,scene_embeddings,scene_embeddings_768,chat_logs,video_courses,tags,apikey,lti_credentials,lms_installations');
    await fixture.pool.query("INSERT INTO users(id,banned,ban_expires,role) VALUES('owner',true,null,'user'),('other',false,null,'user')");
    await fixture.pool.query("INSERT INTO job_executions VALUES($1,'delete_account_data','running',$2,now()+interval '15 minutes')",[grant.jobId,grant.leaseToken]);
    await fixture.pool.query("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',$1,'account-delete:owner')",[{message:{type:'delete_account_data',job_id:grant.jobId,payload:{user_id:'owner'}}}]);
    for(const table of ['scene_embeddings','scene_embeddings_768','chat_logs','video_courses','tags'])await fixture.pool.query(`INSERT INTO ${table}(user_id) VALUES('owner'),('other')`);
    await fixture.pool.query("INSERT INTO apikey VALUES('owner'),('other')");
    await fixture.pool.query("INSERT INTO lms_installations VALUES('installation','owner')");
    await fixture.pool.query("INSERT INTO lti_credentials VALUES($1),($2),($3),($4)",[{ownerUserId:'owner'},{userId:'owner'},{installationId:'installation'},{userId:'other'}]);
  });
  it('removes both profiles and owned credentials while preserving other users and the durable outbox',async()=>{
    expect(await step()).toEqual({status:'completed'});
    expect((await fixture.pool.query('SELECT id FROM users')).rows).toEqual([{id:'other'}]);
    for(const table of ['scene_embeddings','scene_embeddings_768','chat_logs','video_courses','tags'])expect((await fixture.pool.query(`SELECT user_id FROM ${table}`)).rows).toEqual([{user_id:'other'}]);
    expect((await fixture.pool.query('SELECT payload FROM lti_credentials')).rows).toEqual([{payload:{userId:'other'}}]);
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM external_tasks')).rows[0].n).toBe(1);
    expect(await step()).toEqual({status:'completed'});
  });
  it('deletes one video per authorized step and retains storage cleanup until delivery',async()=>{
    await fixture.pool.query("INSERT INTO videos(id,user_id,file) VALUES(1,'owner','owned.mp4'),(2,'other','other.mp4')");
    await fixture.pool.query("INSERT INTO scene_embeddings(user_id,video_id) VALUES('owner',1),('other',2)");
    expect(await step()).toEqual({status:'progress'});
    expect((await fixture.pool.query('SELECT id FROM videos')).rows).toEqual([{id:'2'}]);
    expect((await fixture.pool.query("SELECT payload FROM external_tasks WHERE kind='storage_cleanup'")).rows[0].payload).toMatchObject({file_key:'owned.mp4',user_id:'owner'});
    expect(await step()).toEqual({status:'completed'});
    expect((await fixture.pool.query("SELECT count(*)::int AS n FROM external_tasks WHERE kind='storage_cleanup'")).rows[0].n).toBe(1);
  });
  it.each(["UPDATE users SET banned=false WHERE id='owner'","UPDATE users SET role='user,admin' WHERE id='owner'","UPDATE users SET ban_expires=now()+interval '1 day' WHERE id='owner'","UPDATE job_executions SET lease_until=now()-interval '1 second'","UPDATE job_executions SET lease_token=gen_random_uuid()","UPDATE external_tasks SET payload='{}'"])('rejects revoked authorization or job identity: %s',async sql=>{
      await fixture.pool.query(sql);expect(await step()).toEqual({status:'denied'});
      expect((await fixture.pool.query("SELECT count(*)::int AS n FROM scene_embeddings WHERE user_id='owner'")).rows[0].n).toBe(1);
    });
});
