import type pg from 'pg';
import { withClient } from '../../db/pool';
import type { Bindings } from '../../types/bindings';
import { ltiConfig } from './config';
import { reservationExpression, type LtiOperationKind } from './operation-reservations';

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;
const WALL_BUDGET_MS = 25000;
const tables = { material: 'lti_material_operations', tag: 'lti_course_tag_operations' } as const;
type Counts = { materialOperations: number; tagOperations: number; moderationActors: number; reportAccesses: number };

async function receiptBatch(client: pg.Client, kind: LtiOperationKind, cutoff: Date) {
  const table = tables[kind], key = reservationExpression(kind);
  await client.query(`INSERT INTO lti_operation_reservations(key)
    SELECT key FROM (SELECT ${key} key FROM ${table} WHERE created_at<$1
      ORDER BY created_at,id LIMIT ${BATCH_SIZE}) candidates ORDER BY key ON CONFLICT DO NOTHING`, [cutoff]);
  const removed = await client.query(`WITH candidates AS MATERIALIZED(
      SELECT id,${key} key FROM ${table} WHERE created_at<$1 ORDER BY created_at,id LIMIT ${BATCH_SIZE}),
    locked AS MATERIALIZED(SELECT g.key FROM lti_operation_reservations g JOIN candidates c ON c.key=g.key
      ORDER BY g.key FOR UPDATE OF g SKIP LOCKED)
    DELETE FROM ${table} r USING candidates c,locked l WHERE r.id=c.id AND c.key=l.key AND r.created_at<$1`, [cutoff]);
  const more = await client.query<{ more: boolean }>(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE created_at<$1) more`, [cutoff]);
  return { count: removed.rowCount ?? 0, more: Boolean(more.rows[0].more) };
}

async function moderationBatch(client: pg.Client, cutoff: Date) {
  const removed = await client.query(`WITH candidates AS MATERIALIZED(
    SELECT id FROM course_qa_moderation WHERE lti_actor_id IS NOT NULL AND created_at<$1
      ORDER BY created_at,id LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED)
    UPDATE course_qa_moderation m SET lti_actor_id=NULL FROM candidates c WHERE m.id=c.id`, [cutoff]);
  const more = await client.query<{ more: boolean }>(`SELECT EXISTS(SELECT 1 FROM course_qa_moderation
    WHERE lti_actor_id IS NOT NULL AND created_at<$1) more`, [cutoff]);
  return { count: removed.rowCount ?? 0, more: Boolean(more.rows[0].more) };
}

async function reportBatch(client: pg.Client, cutoff: Date) {
  const removed = await client.query(`WITH candidates AS MATERIALIZED(
    SELECT id FROM lti_report_accesses WHERE created_at<$1 ORDER BY created_at,id LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED)
    DELETE FROM lti_report_accesses r USING candidates c WHERE r.id=c.id`, [cutoff]);
  const more = await client.query<{ more: boolean }>('SELECT EXISTS(SELECT 1 FROM lti_report_accesses WHERE created_at<$1) more', [cutoff]);
  return { count: removed.rowCount ?? 0, more: Boolean(more.rows[0].more) };
}

/** Explicit operator opt-in; shared teaching content and native moderation actors are untouched. */
export async function pruneLtiAudit(env: Bindings, now = new Date()) {
  const days = ltiConfig(env)?.auditRetentionDays;
  const totals: Counts = { materialOperations: 0, tagOperations: 0, moderationActors: 0, reportAccesses: 0 };
  if (days === undefined) return { enabled: false, ...totals, backlog: false };
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid retention clock.');
  const cutoff = new Date(now.getTime() - days * 86400000), deadline = Date.now() + WALL_BUDGET_MS;
  return withClient(env, async client => {
    const pending = new Set(['material', 'tag', 'moderation', 'report'] as const);
    for (let pass = 0; pass < MAX_BATCHES && pending.size && Date.now() < deadline; pass++) {
      let progress = 0;
      for (const kind of pending) {
        if (Date.now() >= deadline) break;
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'");
          const result = kind === 'report' ? await reportBatch(client, cutoff)
            : kind === 'moderation' ? await moderationBatch(client, cutoff) : await receiptBatch(client, kind, cutoff);
          await client.query('COMMIT');
          totals[kind === 'material' ? 'materialOperations' : kind === 'tag' ? 'tagOperations' : kind === 'report' ? 'reportAccesses' : 'moderationActors'] += result.count;
          progress += result.count;
          if (!result.more) pending.delete(kind);
        } catch (error) {
          await client.query('ROLLBACK'); throw error;
        }
      }
      if (!progress) break; // Contended rows remain eligible for the next maintenance invocation.
    }
    const result = { enabled: true, ...totals, backlog: pending.size > 0 };
    if (result.backlog) console.warn(JSON.stringify({ event: 'lti_audit_retention_backlog', ...result }));
    return result;
  });
}
