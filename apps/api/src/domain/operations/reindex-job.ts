import { JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, type JobMessage } from './job-message';
export function reindexAllEmbeddingsMessage(jobId: string): JobMessage {
  return { type: JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, job_id: jobId, payload: {} };
}
