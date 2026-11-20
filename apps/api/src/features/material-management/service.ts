import type { MaterialCommand } from '../../application/material-management';
import type { ManagedMaterialScope, MaterialManagementRepository } from '../../persistence/contracts/material-management-repository';

/** A committed durable job survives an immediate dispatch failure and stays accepted. */
export async function executeLearningMaterialOperation(deps: {
  execute: MaterialManagementRepository['execute'];
  process(taskId: number): Promise<unknown>;
  dispatchDeferred(): void;
}, scope: ManagedMaterialScope, input: MaterialCommand) {
  const result = await deps.execute(scope, input);
  if (result.externalTaskId !== null) {
    try { await deps.process(result.externalTaskId); }
    catch { deps.dispatchDeferred(); }
  }
  return { material: result.material, reused: result.reused, pending: result.externalTaskId !== null };
}
