/** Synthetic, loopback-only measurement of the actual history repository. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createPostgresChatRepository } from '../src/persistence/postgres/chat-repository.ts';

const connectionString = process.env.PAGINATION_BENCH_DATABASE_URL;
if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) {
  throw new Error('PAGINATION_BENCH_DATABASE_URL must point to an isolated loopback PostgreSQL instance');
}
const output = process.argv[2];
if (!output) throw new Error('Pass the output JSON path');
const sizes = (process.env.PAGINATION_BENCH_SIZES ?? '250,10000,100000').split(',').map(Number);
const samples = Number(process.env.PAGINATION_BENCH_SAMPLES ?? 30);
const indexMode = process.env.PAGINATION_BENCH_INDEX ?? 'ordered';
assert(['legacy', 'ordered'].includes(indexMode));
assert(sizes.every(size => Number.isSafeInteger(size) && size >= 100 && size <= 100000));
assert(Number.isSafeInteger(samples) && samples >= 10 && samples <= 100);
const schema = `pagination_${randomUUID().replaceAll('-', '')}`;
let captured = null;
class RecordedClient extends pg.Client {
  query(...args) {
    const config = typeof args[0] === 'string' ? { text: args[0], values: args[1] } : args[0];
    if (captured && typeof config.text === 'string') {
      captured.push({ sql: config.text, params: Array.isArray(config.values) ? config.values : Array.isArray(args[1]) ? args[1] : [] });
    }
    return super.query(...args);
  }
}
const admin = new pg.Client({ connectionString });
await admin.connect();
const pool = new pg.Pool({ connectionString, Client: RecordedClient, options: `-c search_path=${schema}`, max: 1, statement_timeout: 60000 });
const repository = createPostgresChatRepository({ DATABASE_POOL: pool });
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const report = {
  measuredAt: new Date().toISOString(), sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  repositorySha256: createHash('sha256').update(await readFile(new URL('../src/persistence/postgres/chat-repository.ts', import.meta.url))).digest('hex'),
  scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  conditions: { engine: 'PostgreSQL', samples, warmupsPerPage: 2, pageSize: 20, simultaneousRequests: 1,
    data: 'Synthetic; equal-sized target and unrelated courses; three rows share each timestamp; fixed structured answers',
    scope: 'Repository only, warmed loopback pool; not browser, authentication middleware, cold-start or production SLO',
    index: indexMode === 'ordered' ? '(course_id,created_at DESC,id DESC)' : 'Legacy (course_id,created_at DESC)',
    otherIndexes: 'Separate course/user indexes and primary keys; replace ordering index without increasing index count',
    maintenance: 'VACUUM ANALYZE before each scale, then warmups; no concurrent benchmark writers' },
  results: [],
};
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`CREATE TABLE users(id text PRIMARY KEY,username text,email text);
    CREATE TABLE video_courses(id bigint PRIMARY KEY,user_id text NOT NULL);
    CREATE TABLE chat_logs(id bigint PRIMARY KEY,course_id bigint NOT NULL,user_id text,question text NOT NULL,response jsonb NOT NULL,
      is_shared_origin boolean NOT NULL,feedback text,created_at timestamptz NOT NULL);
    CREATE TABLE lti_chat_log_subjects(chat_log_id bigint PRIMARY KEY,classroom_author jsonb);
    CREATE INDEX chat_logs_course_id_idx ON chat_logs(course_id);
    CREATE INDEX chat_logs_user_id_idx ON chat_logs(user_id);
    CREATE INDEX chat_logs_course_created_idx ON chat_logs(course_id,created_at DESC${indexMode === 'ordered' ? ',id DESC' : ''});
    INSERT INTO users VALUES('owner','Owner','owner@example.invalid'),('learner','Learner','learner@example.invalid');
    INSERT INTO video_courses VALUES(1,'owner'),(2,'outsider');`);
  report.serverVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
  for (const size of sizes) {
    await pool.query('TRUNCATE chat_logs,lti_chat_log_subjects');
    await pool.query(`INSERT INTO chat_logs SELECT i,CASE WHEN i<=$1 THEN 1 ELSE 2 END,'learner',repeat('Synthetic question ',8),
      jsonb_build_object('segments',jsonb_build_array(jsonb_build_object('text',repeat('Synthetic answer ',40),'sourceIds','[]'::jsonb)),'sources','[]'::jsonb),
      false,NULL,'2026-01-01T00:00:00Z'::timestamptz+(i/3)*interval '1 second' FROM generate_series(1,$1*2) AS i`, [size]);
    await pool.query('INSERT INTO lti_chat_log_subjects SELECT id,NULL FROM chat_logs WHERE id%5=0');
    for (const table of ['users', 'video_courses', 'chat_logs', 'lti_chat_log_subjects']) await pool.query(`VACUUM (ANALYZE) ${table}`);
    assert.deepEqual(await repository.history(1, 'outsider', 20, 0), { notFound: true });
    const offsets = [0, ...(size > 1020 ? [1000] : []), Math.floor(size / 2), size - 20];
    const pages = offsets.map(offset => ({ offset, times: [], queries: null }));
    async function measure(page, keep) {
      captured = [];
      const start = performance.now();
      const response = await repository.history(1, 'owner', 20, page.offset);
      const elapsed = performance.now() - start;
      const queries = captured; captured = null;
      assert(!('notFound' in response)); assert.equal(response.count, size); assert.equal(queries.length, 2);
      assert.deepEqual(response.results.map(row => row.id), Array.from({ length: 20 }, (_, index) => size - page.offset - index));
      if (keep) { page.times.push(elapsed); page.queries = queries; }
    }
    for (let iteration = 0; iteration < 2; iteration++) for (const page of pages) await measure(page, false);
    for (let iteration = 0; iteration < samples; iteration++) {
      for (const page of iteration % 2 ? [...pages].reverse() : pages) await measure(page, true);
    }
    for (const page of pages) {
      const plans = [];
      for (const query of page.queries) {
        const estimated = (await pool.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params)).rows[0]['QUERY PLAN'];
        const measured = (await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`, query.params)).rows[0]['QUERY PLAN'];
        plans.push({ ...query, estimated, measured });
      }
      report.results.push({ targetCourseRows: size, totalChatRows: size * 2, offset: page.offset, queryCountPerRequest: 2,
        elapsedMs: { p50: percentile(page.times, 0.5), p95: percentile(page.times, 0.95), p99: percentile(page.times, 0.99), sum: page.times.reduce((a, b) => a + b, 0) }, plans });
    }
    const indexBytes = Number((await pool.query("SELECT pg_relation_size('chat_logs_course_created_idx') AS bytes")).rows[0].bytes);
    const writeTimes = [];
    for (let batch = 0; batch < samples; batch++) {
      const start = performance.now();
      await pool.query(`INSERT INTO chat_logs SELECT $1+i,1,'learner','Synthetic write',
        '{"segments":[{"text":"Synthetic answer","sourceIds":[]}],"sources":[]}'::jsonb,false,NULL,
        '2027-01-01T00:00:00Z'::timestamptz FROM generate_series(1,20) AS i`, [size * 2 + batch * 20]);
      writeTimes.push(performance.now() - start);
    }
    for (const result of report.results.filter(result => result.targetCourseRows === size)) {
      result.orderingIndexBytes = indexBytes;
      result.insert20RowsMs = { samples, p50: percentile(writeTimes, 0.5), p95: percentile(writeTimes, 0.95) };
    }
  }
} finally {
  captured = null;
  await pool.end();
  try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await admin.end(); }
}
await writeFile(output, JSON.stringify(report, null, 2).replaceAll(schema, 'benchmark_schema') + '\n');
console.log(JSON.stringify(report.results.map(({ targetCourseRows, offset, elapsedMs }) => ({ targetCourseRows, offset, ...elapsedMs })), null, 2));
