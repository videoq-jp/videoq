export * from '../application/job-message';
import type { JobType, JobMessage } from '../application/job-message';

export function buildJobMessage(
  type: JobType,
  payload: Record<string, unknown> = {},
  jobId: string = crypto.randomUUID(),
): JobMessage {
  return { type, job_id: jobId, payload };
}
