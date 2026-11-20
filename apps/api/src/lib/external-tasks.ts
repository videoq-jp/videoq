/** Compatibility entrypoint for composed outbox delivery. */
export { processExternalTasks, processExternalTaskById } from '../integrations/external-tasks';
export type { ExternalTaskRunResult } from '../features/tasks/service';
