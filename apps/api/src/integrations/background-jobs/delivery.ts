import { parseBackgroundJob } from '../../application/background-job';
import { sendSqsMessage } from '../../lib/sqs';
import type { Bindings } from '../../types/bindings';

/** Keep the durable outbox format while changing only the selected transport. */
export async function deliverJob(env: Bindings, body: string): Promise<string | null> {
  const candidate: unknown = JSON.parse(body);
  const type = typeof candidate === 'object' && candidate !== null && 'type' in candidate ? candidate.type : undefined;
  const account = type === 'delete_account_data';
  const search = ['index_video_transcript','reindex_video_transcript','reindex_all_videos_embeddings'].includes(String(type));
  const backend = account ? env.ACCOUNT_JOB_BACKEND : search ? env.SEARCH_JOB_BACKEND : undefined;
  if (!backend || backend === 'sqs') return sendSqsMessage(env, body);
  if (backend !== 'cloudflare') throw new Error('Invalid background job backend');
  const job = parseBackgroundJob(candidate);
  const queue = account ? env.ACCOUNT_JOBS : env.SEARCH_JOBS;
  if (!queue) throw new Error('Cloudflare background queue binding is missing');
  await queue.send(job);
  return job.job_id;
}
