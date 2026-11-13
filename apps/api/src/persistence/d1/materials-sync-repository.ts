import {buildJobMessage,JOB_TRANSCRIBE_VIDEO} from '../../lib/job-message';
import type {MaterialsSyncRepository,MaterialsConnection,MaterialsLease} from '../contracts/materials-sync-repository';
import {MaterialsLeaseLostError} from '../contracts/materials-sync-repository';
const ACTIVE=`i.active=1 AND i.materials_service IS NOT NULL`;
const CONFIG=`json_object('owner',i.owner_user_id,'client',i.client_id,'deployment',i.deployment_id,'service',json(i.materials_service))`;
const PAYLOAD=`json_object('lease',?,'installationId',i.id,'configuration',${CONFIG})`;
const CONNECTION=`i.id,i.owner_user_id AS ownerUserId,i.client_id AS clientId,i.deployment_id AS deploymentId,i.materials_service AS service,i.materials_cursor AS materialsCursor`;
function leasePredicate(kind:string){return `EXISTS(SELECT 1 FROM lti_credentials lease JOIN lms_installations i ON i.id=json_extract(lease.payload,'$.installationId') JOIN users owner ON owner.id=i.owner_user_id
 WHERE lease.id=? AND i.id=? AND json_extract(lease.payload,'$.lease')=? AND ${kind} AND julianday(lease.expires_at)>julianday('now')
 AND ${ACTIVE} AND json(json_extract(lease.payload,'$.configuration'))=${CONFIG})`;}
export const D1_MATERIALS_LEASE=leasePredicate("lease.kind IN('materials-lease','materials-poll')");
export const D1_MATERIALS_CONTEXT_LEASE=leasePredicate("lease.kind='materials-lease'");
const POLL=leasePredicate("lease.kind='materials-poll'");

type Row=Omit<MaterialsConnection,'materialsService'>&{service:string;leaseId:string};
const connection=(row:Row):MaterialsConnection=>({id:row.id,ownerUserId:row.ownerUserId,clientId:row.clientId,deploymentId:row.deploymentId,materialsService:JSON.parse(row.service) as MaterialsConnection['materialsService'],materialsCursor:row.materialsCursor});
export function createD1MaterialsSyncRepository(database:D1Database):MaterialsSyncRepository {
 const prepare=(sql:string,args:unknown[]=[])=>database.prepare(sql).bind(...args);
 const values=(lease:MaterialsLease)=>[lease.id,lease.installationId,lease.token];
 return {
  async claimContext(installationId,leaseId,token){
   const result=await database.batch<Row>([
    prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT ?,'materials-lease',${PAYLOAD},strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')
     FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE i.id=? AND ${ACTIVE}
     ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at
      WHERE lti_credentials.kind='materials-lease' AND julianday(lti_credentials.expires_at)<julianday('now')`,[leaseId,token,installationId]),
    prepare(`SELECT ${CONNECTION} FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE i.id=? AND ${D1_MATERIALS_CONTEXT_LEASE}`,[installationId,leaseId,installationId,token]),
    prepare(`SELECT ${CONNECTION} FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE i.id=? AND ${ACTIVE}`,[installationId]),
   ]);
   const row=result[1].results[0];return row?{status:'claimed',lease:{id:leaseId,token,installationId},connection:connection(row)}:{status:result[2].results.length?'busy':'unavailable'};
  },
  async owns(lease){return Boolean(await prepare(`SELECT (${D1_MATERIALS_LEASE}) AS owned`,values(lease)).first<number>('owned'));},
  async release(lease){await prepare("DELETE FROM lti_credentials WHERE id=? AND kind IN('materials-lease','materials-poll') AND json_extract(payload,'$.lease')=?",[lease.id,lease.token]).run();},
  async prepareExport(lease,key,contextId,attempt){
   const result=await database.batch<{payload:string}>([
    prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT ?,'materials-export',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') WHERE ${D1_MATERIALS_CONTEXT_LEASE}
     ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at
      WHERE lti_credentials.kind='materials-export' AND julianday(lti_credentials.expires_at)<=julianday('now')`,[key,JSON.stringify({installationId:lease.installationId,contextId,attempt}),...values(lease)]),
    prepare(`SELECT payload FROM lti_credentials WHERE id=? AND kind='materials-export' AND julianday(expires_at)>julianday('now')
     AND json_extract(payload,'$.installationId')=? AND json_extract(payload,'$.contextId')=? AND ${D1_MATERIALS_CONTEXT_LEASE}`,[key,lease.installationId,contextId,...values(lease)]),
   ]);
   const raw=result[1].results[0]?.payload,payload=raw?JSON.parse(raw) as Record<string,unknown>:null;
   if(!payload || typeof payload.attempt!=='string')throw new MaterialsLeaseLostError();
   return {attempt:payload.attempt,...(typeof payload.jobId==='string'?{jobId:payload.jobId}:{})};
  },
  async saveExportJob(lease,key,attempt,jobId){
   return Boolean(await prepare(`UPDATE lti_credentials SET payload=json_set(payload,'$.jobId',?) WHERE id=? AND kind='materials-export' AND julianday(expires_at)>julianday('now')
    AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.installationId')=? AND ${D1_MATERIALS_CONTEXT_LEASE} RETURNING id`,[jobId,key,attempt,lease.installationId,...values(lease)]).first());
  },
  async deleteExport(lease,key,attempt){
   return Boolean(await prepare(`DELETE FROM lti_credentials WHERE id=? AND kind='materials-export' AND json_extract(payload,'$.attempt')=?
    AND json_extract(payload,'$.installationId')=? AND ${D1_MATERIALS_CONTEXT_LEASE} RETURNING id`,[key,attempt,lease.installationId,...values(lease)]).first());
  },
  async confirmUpload(lease,upload){
   const message=buildJobMessage(JOB_TRANSCRIBE_VIDEO,{video_id:upload.videoId}),dedupeKey=`job:${message.job_id}`;
   const result=await database.batch<{id:number}>([
    prepare(`INSERT INTO external_tasks(kind,payload,dedupe_key) SELECT 'sqs_job',?,? FROM videos v WHERE v.id=? AND v.file=? AND v.status='uploading'
     AND EXISTS(SELECT 1 FROM lms_resources r JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=r.installation_id AND t.context_id=r.context_id
       AND t.course_id=r.course_id AND t.active=1 AND t.resource_link_id IS NULL
      JOIN video_courses course ON course.id=t.course_id AND course.user_id=t.owner_user_id
      JOIN users owner ON owner.id=t.owner_user_id AND owner.is_active=1 AND owner.deactivated_at IS NULL AND (owner.banned IS NOT TRUE OR julianday(owner.ban_expires)<=julianday('now'))
      WHERE r.video_id=v.id AND r.installation_id=? AND r.external_id=? AND r.generation=? AND r.enabled=1 AND v.user_id=t.owner_user_id)
     AND ${D1_MATERIALS_CONTEXT_LEASE}`,[JSON.stringify({message}),dedupeKey,upload.videoId,upload.fileKey,lease.installationId,upload.externalId,upload.generation,...values(lease)]),
    prepare(`UPDATE videos SET status='pending',error_message='' WHERE id=? AND changes()=1`,[upload.videoId]),
    prepare('SELECT id FROM external_tasks WHERE dedupe_key=?',[dedupeKey]),
   ]);
   const task=result[2].results[0];return task?{videoId:upload.videoId,taskId:Number(task.id),jobId:message.job_id}:false;
  },
  async claimNext(token){
   const result=await database.batch<Row>([
    prepare(`INSERT INTO lti_credentials(id,kind,payload,expires_at)
     SELECT 'lti-materials-poll:'||i.id,'materials-poll',${PAYLOAD},strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute')
     FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE ${ACTIVE} AND julianday(i.next_materials_sync_at)<=julianday('now')
      AND NOT EXISTS(SELECT 1 FROM lti_credentials c WHERE c.id='lti-materials-poll:'||i.id AND julianday(c.expires_at)>=julianday('now'))
     ORDER BY julianday(i.next_materials_sync_at),i.id LIMIT 1
     ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE lti_credentials.kind='materials-poll' AND julianday(lti_credentials.expires_at)<julianday('now')`,[token]),
    prepare(`UPDATE lms_installations SET next_materials_sync_at=(SELECT expires_at FROM lti_credentials WHERE id='lti-materials-poll:'||lms_installations.id)
     WHERE EXISTS(SELECT 1 FROM lti_credentials c WHERE c.id='lti-materials-poll:'||lms_installations.id AND c.kind='materials-poll' AND json_extract(c.payload,'$.lease')=?)`,[token]),
    prepare(`SELECT ${CONNECTION},c.id AS leaseId FROM lms_installations i JOIN lti_credentials c ON c.id='lti-materials-poll:'||i.id
     JOIN users owner ON owner.id=i.owner_user_id WHERE c.kind='materials-poll' AND json_extract(c.payload,'$.lease')=? AND ${ACTIVE}`,[token]),
   ]);
   const row=result[2].results[0];return row?{lease:{id:row.leaseId,token,installationId:row.id},connection:connection(row)}:null;
  },
  async finishPoll(lease,cursor,delaySeconds){
   if(!Number.isSafeInteger(cursor)||cursor<0||![10,30].includes(delaySeconds))throw new Error('Invalid materials poll completion');
   return Boolean(await prepare(`UPDATE lms_installations SET materials_cursor=?,next_materials_sync_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||?||' seconds')
    WHERE id=? AND ${POLL} RETURNING id`,[cursor,delaySeconds,lease.installationId,...values(lease)]).first());
  },
 };
}
