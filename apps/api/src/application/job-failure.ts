export const SAFE_JOB_FAILURE = Symbol('safe-job-failure');
export const JOB_FAILURE_CODES = ['INVALID_JOB','ACK_FAILED','VISIBILITY_CHANGE_FAILED','INDEX_SOURCE_CHANGED','INVALID_TRANSCRIPT','INVALID_EMBEDDINGS','INDEX_NOT_READY','INDEX_DELIVERY_PENDING','JOB_BUSY','JOB_IDENTITY_CONFLICT','DEADLINE_EXCEEDED','EXECUTION_ABORTED','DATABASE_UNAVAILABLE','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','WORKER_EXECUTION_FAILED','RECOVERY_RESTART_REQUESTED'] as const;
export function safeJobFailureCode(code: string): JobFailureCode { return (JOB_FAILURE_CODES as readonly string[]).includes(code) ? code as JobFailureCode : 'WORKER_EXECUTION_FAILED'; }
export type JobFailureCode = typeof JOB_FAILURE_CODES[number];
export interface Failure { error_code: JobFailureCode; retryable: boolean }
export class SafeJobError extends Error {
  readonly [SAFE_JOB_FAILURE] = true;
  constructor(readonly code: JobFailureCode, readonly retryable: boolean, message: string = code) { super(message); this.name=`SafeJobError_${code}`; }
}
// Exact platform constants only, never persist or emit the inspected text.
const d1Unavailable = new Set(['Network connection lost.','Replica disconnected from primary.','D1 DB reset because its code was updated.','Internal error while starting up D1 DB storage caused object to be reset.','Internal error in D1 DB storage caused object to be reset.','Cannot resolve D1 DB due to transient issue on remote node.']);
const databaseCodes = new Set(['08000', '08001', '08003', '08006', '53300', '57P01', '57P02', '57P03']);

/** Inspect only bounded, allowlisted facts; never log an exception or its cause. */
export function classifyJobFailure(error: unknown): Failure {
  try {
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
      if (current instanceof SafeJobError) return { error_code: safeJobFailureCode(current.code), retryable: current.retryable };
      const facts = current as Record<string, unknown>;
      if ((facts as Record<PropertyKey,unknown>)[SAFE_JOB_FAILURE] === true && typeof facts.code === 'string' && (JOB_FAILURE_CODES as readonly string[]).includes(facts.code) && typeof facts.retryable === 'boolean') return {error_code:safeJobFailureCode(facts.code),retryable:facts.retryable};
      if (facts.name === 'TimeoutError') return { error_code: 'DEADLINE_EXCEEDED', retryable: true };
      if (facts.name === 'AbortError') return { error_code: 'EXECUTION_ABORTED', retryable: true };
      if (typeof facts.code === 'string' && databaseCodes.has(facts.code)) return { error_code: 'DATABASE_UNAVAILABLE', retryable: true };
      if (typeof facts.message === 'string' && facts.message.length <= 256 && facts.message.startsWith('D1_ERROR: ') && d1Unavailable.has(facts.message.slice(10))) return { error_code:'DATABASE_UNAVAILABLE',retryable:true };
      const status = facts.status ?? facts.status_code;
      if (status === 429) return { error_code: 'PROVIDER_RATE_LIMITED', retryable: true };
      if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599) return { error_code: 'PROVIDER_UNAVAILABLE', retryable: true };
      current = facts.cause;
    }
  } catch { /* A diagnostic accessor must never suppress a queue retry. */ }
  return { error_code: 'WORKER_EXECUTION_FAILED', retryable: true };
}

