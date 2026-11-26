import { reindexAllEmbeddingsMessage } from '../domain/operations/reindex-job';
import type { JobMessage } from '../domain/operations/job-message';
export interface ReindexJobDependencies {
  newId: () => string;
  persist: (message: JobMessage) => Promise<{ id: number }>;
  dispatch: (taskId: number) => Promise<unknown>;
}


/** Persist the stable identity before any delivery attempt. */
export async function enqueueReindexAllEmbeddings(deps: ReindexJobDependencies): Promise<string> {
  const message = reindexAllEmbeddingsMessage(deps.newId());
  const task = await deps.persist(message);
  await deps.dispatch(task.id);
  return message.job_id;
}
