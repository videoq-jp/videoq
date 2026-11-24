import { afterEach, expect, it, vi } from 'vitest';
import { AwsClient } from 'aws4fetch';
import { BackgroundJobBusyError, BackgroundJobConflictError } from '../src/application/background-job';
import type { Bindings } from '../src/types/bindings';
vi.mock('../src/integrations/background-jobs/execute', () => ({ runBackgroundJob: vi.fn(async () => {}) }));
import { runBackgroundJob } from '../src/integrations/background-jobs/execute';
import { SqsBackgroundConsumer } from '../src/integrations/background-jobs/sqs-consumer';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it.each([
  [new BackgroundJobBusyError(), 'JOB_BUSY', 960],
  [new BackgroundJobConflictError(), 'JOB_IDENTITY_CONFLICT', 30],
  [Object.assign(new Error('private-signed-url'), { status: 429 }), 'PROVIDER_RATE_LIMITED', 30],
  [Object.assign(new Error('private-signed-url'), { status: 503 }), 'PROVIDER_UNAVAILABLE', 30],
  [Object.assign(new Error('private-sql'), { code: '08006' }), 'DATABASE_UNAVAILABLE', 30],
  [new DOMException('private-token', 'TimeoutError'), 'DEADLINE_EXCEEDED', 30],
] as const)('correlates %s failures and preserves retry visibility', async (error, code, visibility) => {
  const operations: { operation: string; body: Record<string, unknown> }[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(AwsClient.prototype, 'fetch').mockImplementation(async (_input, init) => {
    const operation = new Headers(init?.headers).get('x-amz-target')!.split('.')[1];
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    operations.push({ operation, body });
    return Response.json(operation === 'ReceiveMessage' ? { Messages: [{
      MessageId: 'message-1', ReceiptHandle: 'private-receipt', Attributes: { ApproximateReceiveCount: '3' },
      Body: JSON.stringify({ type: 'delete_account_data', job_id: 'job-1', payload: { user_id: 'private-owner' } }),
    }] } : {});
  });
  vi.mocked(runBackgroundJob).mockRejectedValueOnce(error);
  const env = { AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_REGION: 'us-east-1' } as Bindings;
  await new SqsBackgroundConsumer(env, 'http://queue.example/account', 'account').poll(new AbortController().signal);
  expect(operations.map(value => value.operation)).toEqual(['ReceiveMessage', 'ChangeMessageVisibility']);
  expect(operations[0].body.MessageSystemAttributeNames).toEqual(['ApproximateReceiveCount']);
  expect(operations[1].body.VisibilityTimeout).toBe(visibility);
  const serialized = String(log.mock.calls[0][0]);
  expect(serialized).not.toContain('private-');
  expect(JSON.parse(serialized)).toMatchObject({ event: 'background_job_retry', error_code: code,
    job_id: 'job-1', message_id: 'message-1', job_type: 'delete_account_data', attempts: 3, stage: 'execute' });
});
