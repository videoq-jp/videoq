export * from '../domain/operations/job-message';
import type { JobType, JobMessage, JobMessageArguments, JobPayloadMap } from '../domain/operations/job-message';

export function buildJobMessage(...args: JobMessageArguments): JobMessage;
export function buildJobMessage(
  type: JobType,
  payload: JobPayloadMap[JobType] = {},
  jobId: string = crypto.randomUUID(),
) {
  return { type, job_id: jobId, payload };
}
