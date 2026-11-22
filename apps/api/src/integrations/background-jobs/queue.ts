import { parseBackgroundJob, canonicalBackgroundJob } from '../../application/background-job';
import { runBackgroundJob, sha256 } from './execute';
import type { Bindings } from '../../types/bindings';

export async function consumeBackgroundJobs(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  // Queue batches are deliberately small; account mutations retain the same
  // lease fence, while search work is durably handed to Workflows before ack.
  for (const message of batch.messages) {
    try {
      const job = parseBackgroundJob(message.body);
      if (job.type === 'delete_account_data') await runBackgroundJob(env, job);
      else {
        if (!env.SEARCH_INDEX_WORKFLOW) throw new Error('Search workflow binding is missing');
        const id = await sha256(`${job.job_id}\n${canonicalBackgroundJob(job)}`);
        try { await env.SEARCH_INDEX_WORKFLOW.create({ id, params: job }); }
        catch (error) {
          const instance = await env.SEARCH_INDEX_WORKFLOW.get(id);
          const status = await instance.status();
          if (status.status === 'errored' || status.status === 'terminated') throw error;
          // A duplicate delivery found a durable existing instance.
        }
      }
      message.ack();
    } catch {
      console.error(JSON.stringify({ event: 'background_queue_retry', attempts: message.attempts }));
      message.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.min(message.attempts, 5)) });
    }
  }
}
