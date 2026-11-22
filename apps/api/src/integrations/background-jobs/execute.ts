import { executeBackgroundJob, canonicalBackgroundJob, type BackgroundJob } from '../../application/background-job';
import { executeLeasedAccountDeletion } from '../../application/search-index-execution';
import { createJobRepository, createReindexRepository, stepWorkerAccountDeletion } from '../../persistence/factory';
import { REINDEX_PAGE_SIZE } from '../../persistence/contracts/reindex-repository';
import { createJobTask } from '../../repositories/external-task-repository';
import { processExternalTaskById } from '../../lib/external-tasks';
import { indexTranscript } from '../search-index/index-transcript';
import type { Bindings } from '../../types/bindings';

export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function persistChild(env: Bindings, root: string, job: Omit<BackgroundJob, 'job_id'>): Promise<void> {
  const candidate = { ...job, job_id: root } as BackgroundJob;
  const message = { ...candidate, job_id: await sha256(`${root}\n${canonicalBackgroundJob(candidate)}`) };
  const task = await createJobTask(env, { message });
  await processExternalTaskById(env, task.id);
}

/** Shared by Cloudflare queue consumers/Workflows and the on-prem Node worker. */
export async function runBackgroundJob(env: Bindings, input: unknown, signal?: AbortSignal): Promise<void> {
  const repository = await createJobRepository(env);
  await executeBackgroundJob(input, {
    repository, sha256,
    execute: async (job, leaseToken) => {
      signal?.throwIfAborted();
      if (job.type === 'delete_account_data') {
        await executeLeasedAccountDeletion({
          renew: () => repository.heartbeat(job.job_id, leaseToken),
          step: () => stepWorkerAccountDeletion(env, { userId: job.payload.user_id, jobId: job.job_id, leaseToken }),
        });
        return;
      }
      if (job.type === 'reindex_all_videos_embeddings') {
        const ids = await (await createReindexRepository(env)).candidateIds(job.payload.after_id ?? 0);
        const root = job.payload.root_job_id ?? job.job_id;
        for (const video_id of ids.slice(0, REINDEX_PAGE_SIZE)) {
          signal?.throwIfAborted();
          await persistChild(env, root, { type: 'reindex_video_transcript', payload: { video_id } });
        }
        if (ids.length > REINDEX_PAGE_SIZE) {
          await persistChild(env, root, { type: 'reindex_all_videos_embeddings', payload: { after_id: ids[REINDEX_PAGE_SIZE - 1], root_job_id: root } });
        }
        return;
      }
      await indexTranscript(env, job.payload.video_id, {
        finishIndexing: job.type === 'index_video_transcript',
        allowEmpty: job.type === 'index_video_transcript' && job.payload.allow_empty,
      }, signal);
    },
  });
}
