import type { Bindings } from "../types/bindings";
import type { MaintenanceWindows } from "../persistence/contracts/maintenance-repository";
import { createMaintenanceRepository } from "../persistence/factory";
export type { MaintenanceWindows, MaintenanceWakeup } from "../persistence/contracts/maintenance-repository";

import { policyMaintenanceWakeup } from '../persistence/d1/policy-wakeup';

export async function getNextMaintenanceWakeup(env: Bindings, windows: MaintenanceWindows) {
  return policyMaintenanceWakeup(env, await (await createMaintenanceRepository(env)).getNextWakeup(windows));
}
