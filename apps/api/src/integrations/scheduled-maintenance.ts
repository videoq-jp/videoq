import { applicationTrafficPaused } from "../lib/migration-traffic";
import { maintainSceneIndex, maintainVisualObjects } from "../persistence/factory";
import { pruneLtiAudit } from '../features/lti/audit-retention';
import { sweepMaterials } from "../features/lti/materials-sync";
import { pruneLtiCredentials } from "../features/lti/store";
import {
  EXTERNAL_TASK_LEASE_MS,
  getExternalTaskHealth,
  pruneDeliveryHistory,
} from "../repositories/external-task-repository";
import { failInvitationsWithoutLiveDelivery } from "../repositories/course-invitation-repository";
import type { MaintenanceWindows } from "../repositories/maintenance-schedule-repository";
import type { Bindings } from "../types/bindings";
import {
  processExternalTasks,
} from "../lib/external-tasks";
import {
  ABANDONED_UPLOAD_MS,
  reconcileAbandonedUploads,
} from "../lib/upload-reconcile";
import { pruneMcpIdempotencyRecords } from "../repositories/mcp-idempotency-repository";
import { pruneConversations } from "../repositories/conversation-repository";
import { refreshMaintenanceSchedule } from "../lib/task-scheduler";

import * as workflow from '../features/maintenance/service';
import { observeOperationalPolicy } from './operational-policy/observe';
import type { MaintenanceDependencies } from '../features/maintenance/ports';
import { reconcileCourseSkillInputs } from './course-skill-inputs';
const { INVITATION_QUEUED_STALE_MS } = workflow;
export { RETENTION_CRON, INVITATION_QUEUED_STALE_MS } from '../features/maintenance/service';
export const MAINTENANCE_WINDOWS: MaintenanceWindows = {
  leaseMs: EXTERNAL_TASK_LEASE_MS, abandonedUploadMs: ABANDONED_UPLOAD_MS,
  staleInvitationMs: INVITATION_QUEUED_STALE_MS,
};
function dependencies(env: Bindings): MaintenanceDependencies {
  return {
    get paused() { return applicationTrafficPaused(env); },
    recoverTasks: () => processExternalTasks(env, { limit: 50, arm: false }),
    maintainScenes: () => maintainSceneIndex(env), maintainVisuals: () => maintainVisualObjects(env),
    sweepMaterials: () => sweepMaterials(env), reconcileUploads: () => reconcileAbandonedUploads(env),
    failInvitations: (now, grace) => failInvitationsWithoutLiveDelivery(env, now, grace),
    observePolicy: now => observeOperationalPolicy(env, now),
    reconcileSkills: () => reconcileCourseSkillInputs(env),
    health: () => getExternalTaskHealth(env), pruneHistory: () => pruneDeliveryHistory(env),
    pruneIdempotency: () => pruneMcpIdempotencyRecords(env), pruneConversations: () => pruneConversations(env),
    pruneCredentials: () => pruneLtiCredentials(env), pruneAudit: now => pruneLtiAudit(env, now),
    refresh: progressed => refreshMaintenanceSchedule(env, progressed),
    report: (event, results, failed) => { const message = JSON.stringify({ event, ...results }); if (failed) console.error(message); else console.log(message); },
  };
}
export function runMaintenanceSweep(env: Bindings, now = new Date()) {
  return workflow.runMaintenanceSweep(dependencies(env), now);
}
export function runScheduledMaintenance(env: Bindings, cron: string, now = new Date()) {
  return workflow.runScheduledMaintenance(dependencies(env), cron, now);
}
