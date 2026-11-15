import {LTI_AUDIT_BATCH_SIZE as BATCH_SIZE,type AuditRetentionRepository} from '../contracts/audit-retention-repository';
import {operationReservationKey} from '../../shared/lti-operation-key';
const tables={material:'lti_material_operations',tag:'lti_course_tag_operations',moderation:'course_qa_moderation',report:'lti_report_accesses'} as const;
/** D1 timestamps are canonical UTC ISO text (isoDate/defaults/import contract),
 * so the existing (created_at,id) retention indexes implement strict cutoffs. */
export function createD1AuditRetentionRepository(database:D1Database):AuditRetentionRepository{return {async pruneBatch(kind,cutoff){
 if(!Number.isFinite(cutoff.getTime()))throw new Error('Invalid retention cutoff.');
 const table=tables[kind],at=cutoff.toISOString();
 if(kind==='material'||kind==='tag'){
  const candidates=await database.prepare(`SELECT id,created_at AS createdAt FROM ${table} WHERE created_at<? ORDER BY created_at,id LIMIT ${BATCH_SIZE}`)
   .bind(at).all<{id:string;createdAt:string}>();
  const snapshot=JSON.stringify(await Promise.all(candidates.results.map(async r=>({...r,key:await operationReservationKey(kind,r.id)}))));
  const eligible=`SELECT r.id,json_extract(c.value,'$.key') AS key FROM json_each(?) c JOIN ${table} r
   ON r.id=json_extract(c.value,'$.id') AND r.created_at=json_extract(c.value,'$.createdAt') WHERE r.created_at<?`;
  const result=await database.batch<Record<string,unknown>>([
   database.prepare(`INSERT INTO lti_operation_reservations(key) SELECT key FROM (${eligible}) WHERE 1 ON CONFLICT DO NOTHING`).bind(snapshot,at),
   database.prepare(`DELETE FROM ${table} WHERE id IN(SELECT e.id FROM (${eligible}) e JOIN lti_operation_reservations b ON b.key=e.key)`).bind(snapshot,at),
   database.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE created_at<?) AS more`).bind(at),
  ]);
  return {count:result[1].meta.changes,more:Boolean(result[2].results[0]?.more)};
 }
 const filter=kind==='moderation'?'lti_actor_id IS NOT NULL AND ':'';
 const candidates=`SELECT id FROM ${table} WHERE ${filter}created_at<? ORDER BY created_at,id LIMIT ${BATCH_SIZE}`;
 const result=await database.batch<Record<string,unknown>>([
  database.prepare(kind==='moderation'?`UPDATE ${table} SET lti_actor_id=NULL WHERE id IN(${candidates})`:`DELETE FROM ${table} WHERE id IN(${candidates})`).bind(at),
  database.prepare(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE ${filter}created_at<?) AS more`).bind(at),
 ]);
 return {count:result[0].meta.changes,more:Boolean(result[1].results[0]?.more)};
}};}
