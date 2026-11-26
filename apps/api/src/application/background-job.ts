import { SafeJobError, classifyJobFailure } from '../domain/operations/job-failure';
import type { JobRepository } from './job-execution-port';
import type { JobMessage } from '../domain/operations/job-message';

export type BackgroundJob = Extract<JobMessage, { type:
  'delete_account_data' | 'reindex_video_transcript' | 'index_video_transcript' | 'reindex_all_videos_embeddings'
}>;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function wireString(value: unknown, maxLength: number): value is string {
  // Reject unpaired UTF-16 surrogates: they cannot have the same UTF-8 identity in Python.
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\uD800-\uDFFF]/u.test(value);
}
export function parseBackgroundJob(value: unknown): BackgroundJob {
  if (!record(value) || Object.keys(value).some(k => !['type','job_id','payload'].includes(k)) ||
      !wireString(value.job_id, 128) || !record(value.payload)) throw new Error('Invalid background job');
  const payload = value.payload;
  const fields = Object.keys(payload);
  switch (value.type) {
    case 'delete_account_data':
      if (fields.length === 1 && wireString(payload.user_id, 128) && payload.user_id.trim()) {
        return { type: value.type, job_id: value.job_id, payload: { user_id: payload.user_id } };
      }
      break;
    case 'reindex_video_transcript':
    case 'index_video_transcript':
      if (positive(payload.video_id) && fields.every(k => k === 'video_id' || k === 'allow_empty' && value.type === 'index_video_transcript') &&
          (payload.allow_empty === undefined || typeof payload.allow_empty === 'boolean')) {
        return value.type === 'reindex_video_transcript'
          ? { type: value.type, job_id: value.job_id, payload: { video_id: payload.video_id } }
          : { type: value.type, job_id: value.job_id, payload: { video_id: payload.video_id, ...(typeof payload.allow_empty === 'boolean' ? { allow_empty: payload.allow_empty } : {}) } };
      }
      break;
    case 'reindex_all_videos_embeddings':
      if (fields.every(k => ['after_id','root_job_id'].includes(k)) &&
          (payload.after_id === undefined || typeof payload.after_id === 'number' && Number.isSafeInteger(payload.after_id) && payload.after_id >= 0) &&
          (payload.root_job_id === undefined || payload.after_id !== undefined && wireString(payload.root_job_id, 128) && !!payload.root_job_id.trim())) {
        return { type: value.type, job_id: value.job_id, payload: {
          ...(typeof payload.after_id === 'number' ? { after_id: payload.after_id } : {}),
          ...(typeof payload.root_job_id === 'string' ? { root_job_id: payload.root_job_id } : {}),
        } };
      }
  }
  throw new Error('Invalid or unsupported background job');
}
/** Match json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')). */
export function canonicalBackgroundJob(job: BackgroundJob): string {
  const sorted = Object.fromEntries(Object.entries(job.payload).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ payload: sorted, type: job.type });
}
export interface BackgroundJobDependencies {
  repository: JobRepository;
  sha256(value: string): Promise<string>;
  execute(job: BackgroundJob, leaseToken: string): Promise<void>;
}
export class BackgroundJobBusyError extends SafeJobError {
  constructor() { super('JOB_BUSY', true, 'Background job busy'); }
}
export class BackgroundJobConflictError extends SafeJobError {
  constructor() { super('JOB_IDENTITY_CONFLICT', false, 'Background job conflict'); }
}

export async function executeBackgroundJob(input: unknown, deps: BackgroundJobDependencies): Promise<void> {
  const job = parseBackgroundJob(input);
  const claim = await deps.repository.claim({ jobId: job.job_id, jobType: job.type, payloadSha256: await deps.sha256(canonicalBackgroundJob(job)) });
  if (claim.status === 'completed') return;
  if (claim.status === 'busy') throw new BackgroundJobBusyError();
  if (claim.status !== 'claimed') throw new BackgroundJobConflictError();
  try {
    await deps.execute(job, claim.leaseToken);
    if (!await deps.repository.complete(job.job_id, claim.leaseToken)) throw new Error('Background job lease was lost');
  } catch (error) {
    await deps.repository.fail(job.job_id, claim.leaseToken, classifyJobFailure(error).error_code).catch(() => false);
    throw error;
  }
}
