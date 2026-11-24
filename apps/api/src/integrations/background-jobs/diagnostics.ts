import { BackgroundJobBusyError, BackgroundJobConflictError } from '../../application/background-job';
import { SceneIndexOutcomeError } from '../search-index/outcome';

export type JobStage = 'decode' | 'validate' | 'execute' | 'handoff' | 'ack';
interface Failure { error_code: string; retryable: boolean }
const databaseCodes = new Set(['08000', '08001', '08003', '08006', '53300', '57P01', '57P02', '57P03']);

/** Inspect only bounded, allowlisted facts; never log an exception or its cause. */
export function jobFailure(error: unknown, stage: JobStage): Failure {
  if (stage === 'decode' || stage === 'validate') return { error_code: 'INVALID_JOB', retryable: false };
  if (stage === 'ack') return { error_code: 'ACK_FAILED', retryable: true };
  if (error instanceof BackgroundJobBusyError) return { error_code: 'JOB_BUSY', retryable: true };
  if (error instanceof BackgroundJobConflictError) return { error_code: 'JOB_IDENTITY_CONFLICT', retryable: false };
  if (error instanceof SceneIndexOutcomeError) return { error_code: error.code, retryable: error.retryable };
  try {
    if (error && typeof error === 'object') {
      const facts = error as Record<string, unknown>;
      if (facts.name === 'TimeoutError') return { error_code: 'DEADLINE_EXCEEDED', retryable: true };
      if (facts.name === 'AbortError') return { error_code: 'EXECUTION_ABORTED', retryable: true };
      if (typeof facts.code === 'string' && databaseCodes.has(facts.code)) return { error_code: 'DATABASE_UNAVAILABLE', retryable: true };
      const status = facts.status ?? facts.status_code;
      if (status === 429) return { error_code: 'PROVIDER_RATE_LIMITED', retryable: true };
      if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599) return { error_code: 'PROVIDER_UNAVAILABLE', retryable: true };
    }
  } catch { /* A diagnostic accessor must never suppress a queue retry. */ }
  return { error_code: 'WORKER_EXECUTION_FAILED', retryable: true };
}

export function receiveAttempts(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.length <= 16 && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

interface Observation {
  event: 'background_job_retry' | 'background_queue_retry';
  stage: JobStage;
  group?: 'account' | 'search';
  message_id?: string;
  job_id?: string;
  job_type?: string;
  attempts?: number;
  started: number;
}
export function logJobFailure(error: unknown, observation: Observation): void {
  const { started, ...metadata } = observation;
  console.error(JSON.stringify({ ...metadata, ...jobFailure(error, observation.stage), duration_ms: Math.max(0, Math.round(performance.now() - started)) }));
}
