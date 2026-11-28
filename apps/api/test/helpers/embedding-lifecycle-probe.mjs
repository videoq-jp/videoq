import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
const require = createRequire(process.cwd() + '/package.json');
const pg = require('pg');
const node = process.execPath;
if (!process.env.PERSISTENCE_TEST_DATABASE_URL) throw Error('PERSISTENCE_TEST_DATABASE_URL is required (isolated test PostgreSQL only)');
const adminURL = new URL(process.env.PERSISTENCE_TEST_DATABASE_URL);
const name = 'fp_lifecycle_' + randomUUID().replaceAll('-', '');
const admin = new pg.Client({ connectionString: adminURL.toString() });
await admin.connect();
await admin.query('CREATE DATABASE "' + name + '"');
const databaseURL = new URL(adminURL); databaseURL.pathname = '/' + name;
const pool = new pg.Pool({ connectionString: databaseURL.toString() });
const vector = [1, ...Array(1535).fill(0)]; let modelCalls = 0;
const model = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); modelCalls++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: vector })) }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const modelPort = model.address().port;
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const apiPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
const env = { ...process.env, DATABASE_URL: databaseURL.toString(),
  BETTER_AUTH_URL: `http://127.0.0.1:${modelPort}`, BETTER_AUTH_SECRET: 's'.repeat(48), USER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  R2_ACCESS_KEY_ID: 'synthetic', R2_SECRET_ACCESS_KEY: 'synthetic', R2_S3_ENDPOINT: 'http://127.0.0.1:1', R2_BUCKET_NAME: 'synthetic',
  SQS_QUEUE_URL: 'http://127.0.0.1:1/queue', AWS_ACCESS_KEY_ID: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic',
  EMBEDDING_MODEL: 'same-model', EMBEDDING_REVISION: 'weights-1', EMBEDDING_PREPROCESSING: 'raw-text-v1',
  EMBEDDING_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, EMBEDDING_API_KEY: 'synthetic', PORT: String(apiPort) };
function run(command, overrides = {}) {
  const child = spawn(node, ['apps/api/dist/node.mjs', command], { cwd: process.cwd(), env: { ...env, ...overrides }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', v => output += v); child.stderr.on('data', v => output += v);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  const done = new Promise(resolve => child.on('exit', code => { clearTimeout(timeout); resolve({ code, output }); }));
  return { child, done, output: () => output };
}
let serving;
try {
  await pool.query('CREATE EXTENSION vector');
  await pool.query('CREATE TABLE runtime_rate_limits(key text)');
  await pool.query('CREATE TABLE videos(id integer PRIMARY KEY,user_id text,title text,transcript text,status text,file text)');
  await pool.query('CREATE TABLE scene_embeddings(langchain_id uuid PRIMARY KEY,content text,embedding vector(1536),user_id text,video_id bigint,langchain_metadata json)');
  await pool.query('CREATE TABLE scene_embeddings_768(video_id bigint)');
  await pool.query('INSERT INTO videos VALUES(1,$1,$2,$3,$4,$5)', ['owner','Synthetic','1\n00:00:00,000 --> 00:00:01,000\nSynthetic authoritative source\n','completed','synthetic.mp4']);
  await pool.query('INSERT INTO scene_embeddings VALUES($1,$2,$3,$4,1,$5)', [randomUUID(),'unknown legacy',JSON.stringify(vector),'owner','{}']);
  const blocked = await run('serve').done;
  if (blocked.code === 0 || !blocked.output.includes('FINGERPRINT_MISMATCH') || blocked.output.includes('api_listening')) throw Error('Unknown generation admitted');
  const rebuild = await run('rebuild-embedding-index', { MIGRATION_TRAFFIC_STATE: 'paused' }).done;
  if (rebuild.code !== 0 || !rebuild.output.includes('embedding_rebuild_completed')) throw Error('Rebuild failed: ' + rebuild.output);
  const preflight = await run('embedding-preflight', { MIGRATION_TRAFFIC_STATE: 'paused' }).done;
  if (preflight.code !== 0 || !preflight.output.includes('"serving":true')) throw Error('Resume preflight failed');
  const changed = await run('serve', { EMBEDDING_REVISION: 'weights-2' }).done;
  if (changed.code === 0 || !changed.output.includes('FINGERPRINT_MISMATCH')) throw Error('Changed revision admitted');
  serving = run('serve');
  const deadline = Date.now() + 15000;
  while (!serving.output().includes('api_listening') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!serving.output().includes('api_listening')) throw Error('Compatible server did not listen: ' + serving.output());
  if (!(await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) throw Error('Compatible health failed');
  const receipt = { issue: 1676, synthetic: true, production_mutations: false, node: process.versions.node, persistence: 'isolated PostgreSQL 17',
    unknown_generation_blocked_before_listener: true, paused_rebuild_completed: true, resume_preflight_passed: true,
    same_model_dimensions_changed_revision_blocked: true, compatible_http_health_passed: true, synthetic_model_calls: modelCalls,
    vectors: Number((await pool.query('SELECT count(*) AS n FROM scene_embeddings')).rows[0].n) };
  if (process.env.EMBEDDING_RECEIPT_PATH) await writeFile(process.env.EMBEDDING_RECEIPT_PATH, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  if (serving) { serving.child.kill('SIGTERM'); await serving.done; }
  await new Promise(resolve => model.close(resolve));
  try {
    await pool.end();
    // Pool.end can resolve before PostgreSQL observes the socket closes. Let
    // DROP wait for graceful disconnects instead of terminating an idle client
    // and emitting an asynchronous 57P01 after the rehearsal has passed.
    await admin.query('DROP DATABASE "' + name + '"');
  } finally { await admin.end(); }
}
