import type pg from 'pg';
import {withClient} from '../../db/pool';
import type {Bindings} from '../../types/bindings';
import {reservationExpression} from './operation-reservations';
import type {LtiOperationKind} from '../../shared/lti-operation-key';
import {LTI_AUDIT_BATCH_SIZE as BATCH_SIZE,type AuditRetentionRepository} from '../contracts/audit-retention-repository';
const tables={material:'lti_material_operations',tag:'lti_course_tag_operations'} as const;
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


export function createPostgresAuditRetentionRepository(env:Bindings):AuditRetentionRepository{return {async pruneBatch(kind,cutoff){
 if(!Number.isFinite(cutoff.getTime()))throw new Error('Invalid retention cutoff.');
 return withClient(env,async client=>{
  await client.query('BEGIN');try{
   await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'");
   const result=kind==='report'?await reportBatch(client,cutoff):kind==='moderation'?await moderationBatch(client,cutoff):await receiptBatch(client,kind,cutoff);
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}
 });
}};}
