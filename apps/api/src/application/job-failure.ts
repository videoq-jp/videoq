export const JOB_FAILURE_CODES = ['INDEX_SOURCE_CHANGED','INVALID_TRANSCRIPT','INVALID_EMBEDDINGS','INDEX_NOT_READY','INDEX_DELIVERY_PENDING','JOB_BUSY','JOB_IDENTITY_CONFLICT','DEADLINE_EXCEEDED','EXECUTION_ABORTED','DATABASE_UNAVAILABLE','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','WORKER_EXECUTION_FAILED','RECOVERY_RESTART_REQUESTED'] as const;
export function safeJobFailureCode(code: string): string { return (JOB_FAILURE_CODES as readonly string[]).includes(code) ? code : 'WORKER_EXECUTION_FAILED'; }
export interface Failure { error_code: string; retryable: boolean }
export class SafeJobError extends Error {
  constructor(readonly code: 'INDEX_SOURCE_CHANGED' | 'INVALID_TRANSCRIPT' | 'INVALID_EMBEDDINGS' | 'INDEX_NOT_READY' | 'INDEX_DELIVERY_PENDING' | 'JOB_BUSY' | 'JOB_IDENTITY_CONFLICT', readonly retryable: boolean, message: string = code) { super(message); }
}
const databaseCodes = new Set(['08000', '08001', '08003', '08006', '53300', '57P01', '57P02', '57P03']);

/** Inspect only bounded, allowlisted facts; never log an exception or its cause. */
export function classifyJobFailure(error: unknown): Failure {
  if (error instanceof SafeJobError) return { error_code: error.code, retryable: error.retryable };
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

