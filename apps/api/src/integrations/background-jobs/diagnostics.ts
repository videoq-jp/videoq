import { classifyJobFailure, type Failure } from '../../application/job-failure';

export type JobStage = 'decode' | 'validate' | 'execute' | 'handoff' | 'ack' | 'visibility';
export function jobFailure(error: unknown, stage: JobStage): Failure {
  if (stage === 'decode' || stage === 'validate') return { error_code: 'INVALID_JOB', retryable: false };
  if (stage === 'ack') return { error_code: 'ACK_FAILED', retryable: true };
  if (stage === 'visibility') return { error_code: 'VISIBILITY_CHANGE_FAILED', retryable: true };
  return classifyJobFailure(error);
}

export function receiveAttempts(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.length <= 16 && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

interface Observation {
  event: 'background_job_retry' | 'background_queue_retry' | 'background_visibility_change_failed' | 'background_workflow_failed';
  workflow_id?: string;
  original_error_code?: string;
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
