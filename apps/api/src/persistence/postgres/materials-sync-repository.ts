import {buildJobMessage,JOB_TRANSCRIBE_VIDEO} from '../../lib/job-message';
import type pg from 'pg';
import {sql} from 'drizzle-orm';
import {withClient} from '../../db/pool';
import type {Bindings} from '../../types/bindings';
import type {MaterialsSyncRepository,MaterialsLease,MaterialsConnection} from '../contracts/materials-sync-repository';
import {MaterialsLeaseLostError} from '../contracts/materials-sync-repository';
const ACTIVE=`i.active=true AND i.materials_service IS NOT NULL`;
const CONFIG=`jsonb_build_object('owner',i.owner_user_id,'client',i.client_id,'deployment',i.deployment_id,'service',i.materials_service)`;
const CONNECTION=`i.id,i.owner_user_id AS "ownerUserId",i.client_id AS "clientId",i.deployment_id AS "deploymentId",i.materials_service AS "materialsService",i.materials_cursor AS "materialsCursor"`;
function normalizeConnection(row:MaterialsConnection):MaterialsConnection{
 const cursor=Number(row.materialsCursor);if(!Number.isSafeInteger(cursor)||cursor<0)throw new Error('Invalid materials cursor');
 return {...row,materialsCursor:cursor};
}
export function postgresMaterialsLease(lease:MaterialsLease){return sql`EXISTS(SELECT 1 FROM lti_credentials lease JOIN lms_installations i ON i.id=lease.payload->>'installationId' JOIN users owner ON owner.id=i.owner_user_id
 WHERE lease.id=${lease.id} AND i.id=${lease.installationId} AND lease.payload->>'lease'=${lease.token} AND lease.kind='materials-lease' AND lease.expires_at>clock_timestamp()
 AND ${sql.raw(ACTIVE)} AND lease.payload->'configuration'=${sql.raw(CONFIG)})`;}
const owns=(start:number,kind?:'materials-lease'|'materials-poll')=>`EXISTS(SELECT 1 FROM lti_credentials lease JOIN lms_installations i ON i.id=lease.payload->>'installationId' JOIN users owner ON owner.id=i.owner_user_id
 WHERE lease.id=$${start} AND i.id=$${start+2} AND lease.payload->>'lease'=$${start+1} AND ${kind?`lease.kind='${kind}'`:"lease.kind IN('materials-lease','materials-poll')"} AND lease.expires_at>clock_timestamp() AND ${ACTIVE} AND lease.payload->'configuration'=${CONFIG})`;
export function createPostgresMaterialsSyncRepository(env:Bindings):MaterialsSyncRepository {
 const args=(lease:MaterialsLease)=>[lease.id,lease.token,lease.installationId];
 async function write<T>(lease:MaterialsLease,kind:'materials-lease'|'materials-poll',operation:(client:pg.Client)=>Promise<T>):Promise<T|null>{
  return withClient(env,async client=>{
   await client.query('BEGIN');try{
    // Owner -> connection -> lease matches resource synchronization/revocation.
    // Holding these rows closes the MVCC gap between authorization and a write
    // that waits for an export row owned by another transaction.
    await client.query(`SELECT id FROM users WHERE id IN(SELECT owner_user_id FROM teaching_connections WHERE provider='moodle' AND installation_id=$1) ORDER BY id FOR SHARE`,[lease.installationId]);
    await client.query('SELECT id FROM lms_installations WHERE id=$1 FOR UPDATE',[lease.installationId]);
    const current=await client.query(`SELECT id FROM lti_credentials WHERE id=$1 AND ${owns(1,kind)} FOR SHARE`,args(lease));
    if(!current.rowCount){await client.query('COMMIT');return null;}
    const result=await operation(client);await client.query('COMMIT');return result;
   }catch(error){await client.query('ROLLBACK');throw error;}
  });
 }
 return {
  claimContext(installationId,leaseId,token){return withClient(env,async client=>{
   await client.query('BEGIN');try{
    await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT $1,'materials-lease',jsonb_build_object('lease',$2::text,'installationId',i.id,'configuration',${CONFIG}),clock_timestamp()+interval '10 minutes'
     FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE i.id=$3 AND ${ACTIVE}
     ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE lti_credentials.kind='materials-lease' AND lti_credentials.expires_at<clock_timestamp()`,[leaseId,token,installationId]);
    const row=(await client.query<MaterialsConnection>(`SELECT ${CONNECTION} FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE i.id=$1 AND ${owns(2,'materials-lease')}`,[installationId,leaseId,token,installationId])).rows[0];
    const available=row?true:Boolean((await client.query(`SELECT 1 FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE i.id=$1 AND ${ACTIVE}`,[installationId])).rowCount);
    await client.query('COMMIT');return row?{status:'claimed',lease:{id:leaseId,token,installationId},connection:normalizeConnection(row)}:{status:available?'busy':'unavailable'};
   }catch(error){await client.query('ROLLBACK');throw error;}
  });},
  owns(lease){return withClient(env,async client=>Boolean((await client.query<{owned:boolean}>(`SELECT (${owns(1)}) AS owned`,args(lease))).rows[0].owned));},
  async release(lease){await withClient(env,client=>client.query("DELETE FROM lti_credentials WHERE id=$1 AND kind IN('materials-lease','materials-poll') AND payload->>'lease'=$2",[lease.id,lease.token]));},
  async prepareExport(lease,key,contextId,attempt){
   const value=await write(lease,'materials-lease',async client=>{
    await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT $1,'materials-export',$2::jsonb,clock_timestamp()+interval '1 hour' WHERE ${owns(3,'materials-lease')}
     ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE lti_credentials.kind='materials-export' AND lti_credentials.expires_at<=clock_timestamp()`,[key,JSON.stringify({installationId:lease.installationId,contextId,attempt}),...args(lease)]);
    const payload=(await client.query<{payload:Record<string,unknown>}>(`SELECT payload FROM lti_credentials WHERE id=$1 AND kind='materials-export' AND expires_at>clock_timestamp()
     AND payload->>'installationId'=$2 AND payload->>'contextId'=$3 AND ${owns(4,'materials-lease')}`,[key,lease.installationId,contextId,...args(lease)])).rows[0]?.payload;
    if(!payload || typeof payload.attempt!=='string')throw new MaterialsLeaseLostError();
    return {attempt:payload.attempt,...(typeof payload.jobId==='string'?{jobId:payload.jobId}:{})};
   });
   if(!value)throw new MaterialsLeaseLostError();return value;
  },
  async saveExportJob(lease,key,attempt,jobId){return await write(lease,'materials-lease',async client=>Boolean((await client.query(`UPDATE lti_credentials SET payload=jsonb_set(payload,'{jobId}',to_jsonb($1::text)) WHERE id=$2 AND kind='materials-export' AND expires_at>clock_timestamp()
   AND payload->>'attempt'=$3 AND payload->>'installationId'=$4 AND ${owns(5,'materials-lease')} RETURNING id`,[jobId,key,attempt,lease.installationId,...args(lease)])).rowCount))??false;},
  async deleteExport(lease,key,attempt){return await write(lease,'materials-lease',async client=>Boolean((await client.query(`DELETE FROM lti_credentials WHERE id=$1 AND kind='materials-export' AND payload->>'attempt'=$2 AND payload->>'installationId'=$3 AND ${owns(4,'materials-lease')} RETURNING id`,[key,attempt,lease.installationId,...args(lease)])).rowCount))??false;},
  async confirmUpload(lease,upload){return await write(lease,'materials-lease',async client=>{
   // Lock the resource before its video, matching resource synchronization.
   const resource=await client.query<{owner_user_id:string}>(`SELECT t.owner_user_id FROM lms_resources r
    JOIN teaching_connections t ON t.provider='moodle' AND t.installation_id=r.installation_id AND t.context_id=r.context_id AND t.course_id=r.course_id AND t.active=true AND t.resource_link_id IS NULL
    JOIN video_courses course ON course.id=t.course_id AND course.user_id=t.owner_user_id
    JOIN users owner ON owner.id=t.owner_user_id AND owner.is_active=true AND owner.deactivated_at IS NULL AND (owner.banned IS NOT TRUE OR owner.ban_expires<=clock_timestamp())
    WHERE r.installation_id=$1 AND r.external_id=$2 AND r.generation=$3 AND r.video_id=$4 AND r.enabled=true FOR UPDATE OF r FOR SHARE OF t`,[lease.installationId,upload.externalId,upload.generation,upload.videoId]);
   if(!resource.rowCount)return false;
   const changed=await client.query(`UPDATE videos SET status='pending',error_message='' WHERE id=$1 AND file=$2 AND status='uploading'
    AND user_id=$3 AND ${owns(4,'materials-lease')} RETURNING id`,[upload.videoId,upload.fileKey,resource.rows[0].owner_user_id,...args(lease)]);
   if(!changed.rowCount)return false;
   const message=buildJobMessage(JOB_TRANSCRIBE_VIDEO,{video_id:upload.videoId});
   const task=await client.query<{id:number}>(`INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',$1::jsonb,$2) RETURNING id`,[JSON.stringify({message}),`job:${message.job_id}`]);
   return {videoId:upload.videoId,taskId:Number(task.rows[0].id),jobId:message.job_id};
  })??false;},
  claimNext(token){return withClient(env,async client=>{
   await client.query('BEGIN');try{
    const row=(await client.query<MaterialsConnection>(`SELECT ${CONNECTION} FROM lms_installations i JOIN users owner ON owner.id=i.owner_user_id WHERE ${ACTIVE} AND i.next_materials_sync_at<=clock_timestamp()
     AND NOT EXISTS(SELECT 1 FROM lti_credentials c WHERE c.id='lti-materials-poll:'||i.id AND c.expires_at>=clock_timestamp())
     ORDER BY i.next_materials_sync_at,i.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED`)).rows[0];
    if(!row){await client.query('COMMIT');return null;}
    const id='lti-materials-poll:'+row.id;
    const inserted=await client.query(`INSERT INTO lti_credentials(id,kind,payload,expires_at) SELECT $1,'materials-poll',jsonb_build_object('lease',$2::text,'installationId',i.id,'configuration',${CONFIG}),clock_timestamp()+interval '1 minute'
     FROM lms_installations i WHERE i.id=$3 ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE lti_credentials.kind='materials-poll' AND lti_credentials.expires_at<clock_timestamp() RETURNING id`,[id,token,row.id]);
    if(!inserted.rowCount){await client.query('COMMIT');return null;}
    await client.query(`UPDATE lms_installations SET next_materials_sync_at=(SELECT expires_at FROM lti_credentials WHERE id=$1) WHERE id=$2`,[id,row.id]);
    await client.query('COMMIT');return {lease:{id,token,installationId:row.id},connection:normalizeConnection(row)};
   }catch(error){await client.query('ROLLBACK');throw error;}
  });},
  async finishPoll(lease,cursor,delaySeconds){
   if(!Number.isSafeInteger(cursor)||cursor<0||![10,30].includes(delaySeconds))throw new Error('Invalid materials poll completion');
   return await write(lease,'materials-poll',async client=>Boolean((await client.query(`UPDATE lms_installations SET materials_cursor=$1,next_materials_sync_at=(clock_timestamp()+($2*interval '1 second')) WHERE id=$3 AND ${owns(4,'materials-poll')} RETURNING id`,[cursor,delaySeconds,lease.installationId,...args(lease)])).rowCount))??false;
  },
 };
}
