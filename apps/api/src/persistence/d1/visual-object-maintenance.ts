import { createVisualObjectCleanup } from './visual-objects';
import { maintainVisualObjects } from '../../features/maintenance/visual-object-service';
export { visualObjectKeys } from '../../features/maintenance/visual-object-service';

/** Compatibility adapter; claiming and lease fencing remain atomic in D1. */
export function maintainD1VisualObjects(database: D1Database, remove: (key: string) => Promise<void>, limit = 5) {
  return maintainVisualObjects(createVisualObjectCleanup(database), remove, limit);
}
