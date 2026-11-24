import { afterEach, expect, it, vi } from 'vitest';
import { BackgroundJobBusyError, BackgroundJobConflictError } from '../src/application/background-job';
import { jobFailure, logJobFailure } from '../src/integrations/background-jobs/diagnostics';

afterEach(() => vi.restoreAllMocks());
it.each([
  ['decode', new SyntaxError('private-token'), 'INVALID_JOB', false],
  ['validate', new Error('private-token'), 'INVALID_JOB', false],
  ['execute', new BackgroundJobBusyError(), 'JOB_BUSY', true],
  ['execute', new BackgroundJobConflictError(), 'JOB_IDENTITY_CONFLICT', false],
  ['execute', Object.assign(new Error('signed-url'), { status: 429 }), 'PROVIDER_RATE_LIMITED', true],
  ['execute', Object.assign(new Error('signed-url'), { status: 503 }), 'PROVIDER_UNAVAILABLE', true],
  ['execute', Object.assign(new Error('sql-private'), { code: '08006' }), 'DATABASE_UNAVAILABLE', true],
  ['execute', new DOMException('private-token', 'TimeoutError'), 'DEADLINE_EXCEEDED', true],
  ['ack', new Error('receipt-private'), 'ACK_FAILED', true],
  ['execute', new Error('private-token'), 'WORKER_EXECUTION_FAILED', true],
] as const)('classifies %s failures as %s', (stage, error, error_code, retryable) => {
  expect(jobFailure(error, stage)).toEqual({ error_code, retryable });
});

it('logs only approved metadata without exception, payload or receipt fields', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const secret = 'signed-url-token-private-subtitle';
  logJobFailure(Object.assign(new Error(secret, { cause: new Error(secret) }), { status: 429, request: { token: secret } }), {
    event: 'background_job_retry', stage: 'execute', group: 'search', message_id: 'message-1', job_id: 'job-1',
    job_type: 'index_video_transcript', attempts: 3, started: performance.now(),
  });
  const output = String(spy.mock.calls[0][0]);
  expect(output).not.toContain(secret);
  expect(JSON.parse(output)).toMatchObject({ error_code: 'PROVIDER_RATE_LIMITED', retryable: true, message_id: 'message-1', job_id: 'job-1', attempts: 3, stage: 'execute' });
  expect(JSON.parse(output).duration_ms).toBeGreaterThanOrEqual(0);
});

it('does not let an unreadable exception suppress transport retry', () => {
  const error = Object.defineProperty(new Error(), 'status', { get() { throw new Error('private'); } });
  expect(jobFailure(error, 'execute')).toEqual({ error_code: 'WORKER_EXECUTION_FAILED', retryable: true });
});
