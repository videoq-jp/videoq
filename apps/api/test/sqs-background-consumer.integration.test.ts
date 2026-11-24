import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { AwsClient } from 'aws4fetch';
import type { Bindings } from '../src/types/bindings';
import { executeBackgroundJob, type BackgroundJob } from '../src/application/background-job';
import { createPostgresJobRepository } from '../src/persistence/postgres/job-repository';
vi.mock('../src/integrations/background-jobs/execute', () => ({ runBackgroundJob: vi.fn(async () => {}) }));
import { runBackgroundJob } from '../src/integrations/background-jobs/execute';
import { SqsBackgroundConsumer } from '../src/integrations/background-jobs/sqs-consumer';

const endpoint = process.env.SQS_TEST_ENDPOINT ?? '';
const databaseUrl = process.env.PERSISTENCE_TEST_DATABASE_URL ?? '';
interface QueueResponse {
  QueueUrl?: string;
  Messages?: { ReceiptHandle: string }[];
  Attributes?: Record<string, string>;
}
const digest = async (value: string) => createHash('sha256').update(value).digest('hex');

(endpoint && databaseUrl ? describe : describe.skip)('Node consumer failure boundaries with real PostgreSQL and SQS-compatible HTTP', () => {
  const aws = new AwsClient({ accessKeyId: 'local', secretAccessKey: 'local', region: 'us-east-1', service: 'sqs', retries: 0 });
  let admin: pg.Client;
  let pool: pg.Pool;
  let schema: string;
  let queueUrl: string;
  let consumer: SqsBackgroundConsumer;
  let proxy: Server;
  let receipt: string;
  let failDelete: boolean;
  let failVisibility: boolean;
  let dependencyDown: boolean;
  let onTask: (() => void) | undefined;
  let serverError: unknown;
  let operations: { operation: string; body: Record<string, unknown> }[];
  let log: ReturnType<typeof vi.spyOn>;
  const requests = new Set<AbortController>();
  const job: BackgroundJob = { type: 'reindex_video_transcript', job_id: 'stable-replay', payload: { video_id: 1 } };

  async function request(operation: string, body: Record<string, unknown> = {}): Promise<QueueResponse> {
    const response = await aws.fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${operation}` },
      body: JSON.stringify({ ...(queueUrl ? { QueueUrl: queueUrl } : {}), ...body }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Test SQS ${operation} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) as QueueResponse : {};
  }
  async function send(input: unknown = job) { await request('SendMessage', { MessageBody: JSON.stringify(input) }); }
  async function makeVisible() { await request('ChangeMessageVisibility', { ReceiptHandle: receipt, VisibilityTimeout: 0 }); }
  async function pending() {
    const state = await request('GetQueueAttributes', { AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] });
    return Number(state.Attributes?.ApproximateNumberOfMessages) + Number(state.Attributes?.ApproximateNumberOfMessagesNotVisible);
  }
  async function effects() { return Number((await pool.query('SELECT count(*) AS count FROM test_effects')).rows[0].count); }

  beforeEach(async () => {
    operations = []; receipt = ''; queueUrl = ''; failDelete = false; failVisibility = false;
    dependencyDown = false; onTask = undefined; serverError = undefined;
    vi.clearAllMocks();
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
    schema = `consumer_${crypto.randomUUID().replaceAll('-', '')}`;
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
    await pool.query(`CREATE TABLE job_executions (
      job_id text PRIMARY KEY, job_type text NOT NULL, payload_sha256 text NOT NULL,
      status text NOT NULL, attempts integer NOT NULL DEFAULT 0, lease_token text,
      lease_until timestamptz, completed_at timestamptz, last_error text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    ); CREATE TABLE test_effects (job_id text NOT NULL)`);
    const created = await request('CreateQueue', { QueueName: schema });
    if (!created.QueueUrl) throw new Error('Test broker did not create queue');
    // Normalize the advertised hostname to the explicitly configured test broker.
    queueUrl = new URL(new URL(created.QueueUrl).pathname, endpoint).href;
    const repository = createPostgresJobRepository({ DATABASE_POOL: pool } as Bindings);
    vi.mocked(runBackgroundJob).mockImplementation(async (_env, input, signal) => {
      await executeBackgroundJob(input, { repository, sha256: digest, execute: async parsed => {
        onTask?.(); signal?.throwIfAborted();
        if (dependencyDown) throw Object.assign(new Error('synthetic-private-provider-response'), { status: 503 });
        await pool.query('INSERT INTO test_effects(job_id) VALUES($1)', [parsed.job_id]);
      } });
    });
    proxy = createServer((req, res) => {
      const controller = new AbortController(); requests.add(controller);
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        const target = String(req.headers['x-amz-target']);
        const operation = target.split('.')[1]; operations.push({ operation, body });
        if (operation === 'DeleteMessage' && failDelete || operation === 'ChangeMessageVisibility' && failVisibility) {
          failDelete = false;
          res.writeHead(503, { 'content-type': 'application/x-amz-json-1.0' }); res.end('{}'); return;
        }
        const response = await fetch(endpoint, { method: 'POST', headers: {
          'content-type': 'application/x-amz-json-1.0', 'x-amz-target': target,
        }, body: JSON.stringify({ ...body, QueueUrl: queueUrl }), signal: controller.signal });
        const text = await response.text();
        if (operation === 'ReceiveMessage') {
          const parsed = JSON.parse(text) as QueueResponse;
          receipt = parsed.Messages?.[0]?.ReceiptHandle ?? receipt;
        }
        res.writeHead(response.status, { 'content-type': 'application/x-amz-json-1.0' }); res.end(text);
      })().catch(error => {
        if (!controller.signal.aborted) { serverError = error; res.writeHead(500); res.end('{}'); }
      }).finally(() => requests.delete(controller));
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Missing fault proxy port');
    const consumerUrl = new URL(new URL(queueUrl).pathname, `http://127.0.0.1:${address.port}`).href;
    consumer = new SqsBackgroundConsumer({ AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_REGION: 'us-east-1' } as Bindings, consumerUrl, 'search');
  });
  afterEach(async () => {
    log?.mockRestore();
    for (const controller of requests) controller.abort();
    if (proxy) { const closed = new Promise<void>(resolve => proxy.close(() => resolve())); proxy.closeAllConnections(); await closed; }
    try { if (queueUrl) await request('DeleteQueue'); }
    finally {
      try { await pool?.end(); }
      finally { if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } }
    }
    expect(serverError).toBeUndefined();
  });

  it('deletes only after successful execution and completion', async () => {
    await send(); await consumer.poll(AbortSignal.timeout(10_000));
    expect(await effects()).toBe(1); expect(await pending()).toBe(0);
    expect(operations.map(value => value.operation)).toEqual(['ReceiveMessage', 'DeleteMessage']);
  });
  it('replays after lost acknowledgement without repeating a committed side effect', async () => {
    failDelete = true;
    await send(); await consumer.poll(AbortSignal.timeout(10_000));
    expect(await effects()).toBe(1); expect(await pending()).toBe(1);
    expect((await pool.query('SELECT status FROM job_executions')).rows[0].status).toBe('completed');
    await makeVisible(); await consumer.poll(AbortSignal.timeout(10_000));
    expect(await effects()).toBe(1); expect(await pending()).toBe(0);
    expect(JSON.stringify(log.mock.calls)).toContain('ACK_FAILED');
  });
  it('releases failed work and completes the same ID after downstream recovery', async () => {
    dependencyDown = true;
    await send(); await consumer.poll(AbortSignal.timeout(10_000));
    expect(await effects()).toBe(0); expect(await pending()).toBe(1);
    expect((await pool.query('SELECT status FROM job_executions')).rows[0].status).toBe('failed');
    dependencyDown = false;
    await makeVisible(); await consumer.poll(AbortSignal.timeout(10_000));
    expect(await effects()).toBe(1); expect(await pending()).toBe(0);
    expect((await pool.query('SELECT attempts FROM job_executions')).rows[0].attempts).toBe(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-provider-response');
  });
  it.each(['busy', 'conflict', 'invalid'] as const)('keeps %s work for retry or DLQ', async kind => {
    if (kind !== 'invalid') {
      await createPostgresJobRepository({ DATABASE_POOL: pool } as Bindings).claim({
        jobId: job.job_id, jobType: job.type, payloadSha256: await digest(kind === 'busy'
          ? '{"payload":{"video_id":1},"type":"reindex_video_transcript"}' : 'different payload'),
      });
    }
    await send(kind === 'invalid' ? { ...job, payload: { video_id: true } } : job);
    await consumer.poll(AbortSignal.timeout(10_000));
    expect(await effects()).toBe(0); expect(await pending()).toBe(1);
    expect(operations.some(value => value.operation === 'DeleteMessage')).toBe(false);
    expect(operations.find(value => value.operation === 'ChangeMessageVisibility')?.body.VisibilityTimeout).toBe(kind === 'busy' ? 960 : 30);
  });
  it('retains work when the visibility-change request also fails', async () => {
    dependencyDown = true; failVisibility = true;
    await send(); await consumer.poll(AbortSignal.timeout(10_000));
    expect(await effects()).toBe(0); expect(await pending()).toBe(1);
    expect(operations.some(value => value.operation === 'DeleteMessage')).toBe(false);
  });
  it.each(['AbortError', 'TimeoutError'])('does not acknowledge execution interrupted by %s', async name => {
    const controller = new AbortController();
    onTask = () => controller.abort(new DOMException('synthetic-interruption', name));
    await send(); await consumer.poll(controller.signal);
    expect(await effects()).toBe(0); expect(await pending()).toBe(1);
    expect((await pool.query('SELECT status FROM job_executions')).rows[0].status).toBe('failed');
    expect(operations.some(value => value.operation === 'DeleteMessage')).toBe(false);
  });
});
