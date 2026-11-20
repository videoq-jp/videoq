import { createAuditRetentionRepository } from '../../persistence/factory';
import { pruneAuditRetention } from '../maintenance/audit-retention-service';
import type { Bindings } from '../../types/bindings';
import { ltiConfig } from './config';
export async function pruneLtiAudit(env: Bindings, now = new Date()) {
  return pruneAuditRetention(ltiConfig(env)?.auditRetentionDays, now, {
    nowMs: () => Date.now(), repository: () => createAuditRetentionRepository(env),
    reportBacklog: result => console.warn(JSON.stringify({ event: 'lti_audit_retention_backlog', ...result })),
  });
}
