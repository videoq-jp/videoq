import type {AccountDeletionLease,WorkerAccountDeletion} from '../contracts/worker-account-deletion';
import {createD1VideoMutationRepository} from './video-mutation-repository';
function authorization(g:AccountDeletionLease){return {
 sql:`EXISTS(SELECT 1 FROM job_executions j JOIN external_tasks t ON t.dedupe_key=?
  WHERE j.job_id=? AND j.job_type='delete_account_data' AND j.status='running' AND j.lease_token=? AND julianday(j.lease_until)>julianday('now')
   AND t.kind='sqs_job' AND json_extract(t.payload,'$.message.type')='delete_account_data'
   AND json_extract(t.payload,'$.message.job_id')=j.job_id AND json_extract(t.payload,'$.message.payload.user_id')=?)
  AND NOT EXISTS(SELECT 1 FROM users u WHERE u.id=? AND (coalesce(u.banned,0)<>1 OR u.ban_expires IS NOT NULL OR instr(','||coalesce(u.role,'')||',',',admin,')>0))`,
 params:[`account-delete:${g.userId}`,g.jobId,g.leaseToken,g.userId,g.userId]};}
/** Cloud worker operations are bounded and resume from the remaining DB rows. */
export function createD1WorkerAccountDeletion(database:D1Database,notify:()=>Promise<void>):WorkerAccountDeletion{return {async step(grant){
 const fence=authorization(grant),prepare=(s:string,p:unknown[]=[])=>database.prepare(s).bind(...p);
 const live=await prepare(`SELECT 1 AS allowed WHERE ${fence.sql}`,fence.params).first();if(!live)return {status:'denied'};
 const video=await prepare('SELECT id FROM videos WHERE user_id=? ORDER BY id LIMIT 1',[grant.userId]).first<{id:number}>();
 if(video){
  const result=await createD1VideoMutationRepository(database,notify,fence).delete(video.id,grant.userId);
  return {status:result.deleted?'progress':'denied'};
 }
 const token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?)';
 const result=await database.batch<Record<string,unknown>>([
  prepare(`INSERT INTO mutation_receipts(token,kind,resource_id) SELECT ?,'account_delete',0 WHERE ${fence.sql} AND NOT EXISTS(SELECT 1 FROM videos WHERE user_id=?)`,[token,...fence.params,grant.userId]),
  // Explicit NO ACTION ownership rows are drained before deleting the root.
  ...['chat_logs','course_evaluation_snapshots','video_courses','tags'].map(table=>prepare(`DELETE FROM ${table} WHERE id IN(SELECT id FROM ${table} WHERE user_id=? ORDER BY id LIMIT 100) AND ${gate}`,[grant.userId,token])),
  prepare(`DELETE FROM apikey WHERE id IN(SELECT id FROM apikey WHERE reference_id=? ORDER BY id LIMIT 100) AND ${gate}`,[grant.userId,token]),
  prepare(`DELETE FROM lti_credentials WHERE id IN(SELECT id FROM lti_credentials WHERE json_extract(payload,'$.ownerUserId')=? OR json_extract(payload,'$.userId')=? OR json_extract(payload,'$.installationId') IN(SELECT id FROM lms_installations WHERE owner_user_id=?) ORDER BY id LIMIT 100) AND ${gate}`,[grant.userId,grant.userId,grant.userId,token]),
  prepare(`DELETE FROM users WHERE id=? AND ${gate}
    AND NOT EXISTS(SELECT 1 FROM videos WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM chat_logs WHERE user_id=?)
    AND NOT EXISTS(SELECT 1 FROM course_evaluation_snapshots WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM video_courses WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM tags WHERE user_id=?) AND NOT EXISTS(SELECT 1 FROM apikey WHERE reference_id=?)
    AND NOT EXISTS(SELECT 1 FROM lti_credentials WHERE json_extract(payload,'$.ownerUserId')=? OR json_extract(payload,'$.userId')=? OR json_extract(payload,'$.installationId') IN(SELECT id FROM lms_installations WHERE owner_user_id=?))`,[grant.userId,token,...Array.from({length:9},()=>grant.userId)]),
  prepare(`SELECT EXISTS(SELECT 1 FROM mutation_receipts WHERE token=?) AS allowed,EXISTS(SELECT 1 FROM users WHERE id=?) AS remaining`,[token,grant.userId]),
  prepare('DELETE FROM mutation_receipts WHERE token=?',[token]),
 ]);
 const state=result[8].results[0];if(!state?.allowed)return {status:'denied'};
 await notify();return {status:state.remaining?'progress':'completed'};
 }};}
