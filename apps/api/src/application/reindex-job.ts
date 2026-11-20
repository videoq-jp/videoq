import { JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, type JobMessage } from './job-message';

export interface ReindexJobDependencies {
  newId: () => string;
  persist: (message: JobMessage) => Promise<{ id: number }>;
  dispatch: (taskId: number) => Promise<unknown>;
}

/** Persist the identity before delivery; a delayed outbox keeps that same job. */
export async function enqueueReindexAllEmbeddings(deps: ReindexJobDependencies): Promise<string> {
  const message: JobMessage = {
    type: JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS, job_id: deps.newId(), payload: {},
  };
  const task = await deps.persist(message);
  await deps.dispatch(task.id);
  return message.job_id;
}
