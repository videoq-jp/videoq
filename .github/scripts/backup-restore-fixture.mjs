// This test contains synthetic data only and never reads production credentials.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../operations-tools/package.json', import.meta.url));
const { Client } = require('pg');
const docker = promisify(execFile);
const name = 'videoq-restore-fixture-' + randomBytes(8).toString('hex');
const image = (await fs.readFile(new URL('../operations-tools/Dockerfile', import.meta.url), 'utf8')).trim().replace(/^FROM /, '');
const client = new Client({ connectionString: 'postgresql://postgres:fixture-only@127.0.0.1:54320/postgres' });
try {
  await docker('docker', ['run', '--detach', '--name', name, '-e', 'POSTGRES_PASSWORD=fixture-only',
    '-p', '127.0.0.1:54320:5432', image]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await docker('docker', ['exec', name, 'pg_isready', '-U', 'postgres']); break; }
    catch { await delay(1000); }
  }
  await client.connect();
  await client.query(`CREATE EXTENSION vector;
    CREATE TABLE restore_parent(id integer PRIMARY KEY);
    CREATE TABLE restore_child(id integer PRIMARY KEY, parent_id integer REFERENCES restore_parent(id));
    CREATE TABLE restore_vectors(id integer PRIMARY KEY, embedding vector(3));
    INSERT INTO restore_parent VALUES (1); INSERT INTO restore_child VALUES (2,1);
    INSERT INTO restore_vectors VALUES (1, '[1,2,3]');
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
    INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES('synthetic-migration',1770000000000);
    CREATE SCHEMA videoq_security;
    CREATE TABLE videoq_security.smoke_identities(user_id integer PRIMARY KEY REFERENCES public.restore_parent(id));
    INSERT INTO videoq_security.smoke_identities VALUES(1);
    CREATE SCHEMA chat_memory;
    CREATE TABLE chat_memory.checkpoint_migrations(v integer PRIMARY KEY);
    CREATE TABLE chat_memory.checkpoints(thread_id text NOT NULL, checkpoint_ns text NOT NULL DEFAULT '', checkpoint_id text NOT NULL,
      parent_checkpoint_id text, type text, checkpoint jsonb NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id),
      CHECK(checkpoint='{"messages":["合成 model memory"],"counter":9007199254740993}'::jsonb AND metadata='{"source":"fixture"}'::jsonb));
    CREATE TABLE chat_memory.checkpoint_blobs(thread_id text NOT NULL, checkpoint_ns text NOT NULL DEFAULT '', channel text NOT NULL,
      version text NOT NULL, type text NOT NULL, blob bytea, owner_id integer REFERENCES public.restore_parent(id),
      PRIMARY KEY(thread_id,checkpoint_ns,channel,version), CHECK(blob IS NOT NULL AND blob=decode('00ff225c80','hex')));
    CREATE TABLE chat_memory.checkpoint_writes(thread_id text NOT NULL, checkpoint_ns text NOT NULL DEFAULT '', checkpoint_id text NOT NULL,
      task_id text NOT NULL, idx integer NOT NULL, channel text NOT NULL, type text, blob bytea NOT NULL, task_path text NOT NULL DEFAULT '',
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx), CHECK(blob=decode('ff000a','hex')));
    INSERT INTO chat_memory.checkpoint_migrations VALUES(0);
    INSERT INTO chat_memory.checkpoints(thread_id,checkpoint_id,type,checkpoint,metadata)
      VALUES('synthetic-thread','checkpoint','json','{"messages":["合成 model memory"],"counter":9007199254740993}','{"source":"fixture"}');
    INSERT INTO chat_memory.checkpoint_blobs(thread_id,channel,version,type,blob,owner_id)
      VALUES('synthetic-thread','messages','1','msgpack',decode('00ff225c80','hex'),1);
    INSERT INTO chat_memory.checkpoint_writes(thread_id,checkpoint_id,task_id,idx,channel,type,blob,task_path)
      VALUES('synthetic-thread','checkpoint','task',0,'messages','msgpack',decode('ff000a','hex'),'synthetic/task');`);
  process.env.DATABASE_URL = 'postgresql://postgres:fixture-only@127.0.0.1:54320/postgres';
  await import('./backup-restore.mjs');
  const report = JSON.parse(await fs.readFile('operations-report.json', 'utf8'));
  assert.equal(report.status, 'ok', JSON.stringify(report));
  assert.match(report.summary, /^9テーブル/, 'Every application, migration, security and model-memory table must be verified.');
  console.log('Synthetic vector data, binary model memory and all nine tables across four schemas restored successfully.');
} finally {
  await client.end().catch(() => {});
  await docker('docker', ['rm', '--force', '--volumes', name]);
}
