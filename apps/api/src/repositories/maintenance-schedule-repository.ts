import type { Bindings } from "../types/bindings";
import type { MaintenanceWindows } from "../persistence/contracts/maintenance-repository";
import { createMaintenanceRepository } from "../persistence/factory";
export type { MaintenanceWindows, MaintenanceWakeup } from "../persistence/contracts/maintenance-repository";

export async function getNextMaintenanceWakeup(env: Bindings, windows: MaintenanceWindows) {
  return (await createMaintenanceRepository(env)).getNextWakeup(windows);
}
