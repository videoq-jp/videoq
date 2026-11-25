import type { Bindings } from '../../types/bindings';
import type { MaintenanceWakeup } from '../contracts/maintenance-repository';
import { persistenceBackend } from '../backend';
/** Due facts wake the existing scheduler; leases/backoff defer their own event only. */
export async function policyMaintenanceWakeup(env:Bindings,base:MaintenanceWakeup):Promise<MaintenanceWakeup> {
 if(persistenceBackend(env)!=='d1'||!env.DB||!env.OPERATIONAL_POLICY_WEBHOOK_URL||!env.OPERATIONAL_POLICY_WEBHOOK_TOKEN) return base;
 const row=await env.DB.prepare(`WITH candidates(id,due) AS (
  SELECT 'readiness:'||video_id||':'||source_revision,
   CASE WHEN ready_at IS NULL THEN (julianday(transcript_accepted_at)-2440587.5)*86400000+900001 ELSE (julianday(ready_at)-2440587.5)*86400000 END
  FROM policy_readiness WHERE ready_at IS NULL OR (julianday(ready_at)-julianday(transcript_accepted_at))*86400000>900000
  UNION ALL
  SELECT 'cleanup:'||id||':warning',(julianday(logical_deleted_at)-2440587.5)*86400000+3600001 FROM policy_cleanup
   WHERE completed_at IS NULL AND (julianday('now')-julianday(logical_deleted_at))*86400000<=86400000
  UNION ALL
  SELECT 'cleanup:'||id||':incident',CASE WHEN completed_at IS NULL THEN (julianday(logical_deleted_at)-2440587.5)*86400000+86400001 ELSE (julianday(completed_at)-2440587.5)*86400000 END
  FROM policy_cleanup WHERE completed_at IS NULL OR (julianday(completed_at)-julianday(logical_deleted_at))*86400000>86400000
 ), deadlines(due) AS (
  SELECT max(c.due,coalesce((julianday(n.lease_until)-2440587.5)*86400000,c.due))
  FROM candidates c LEFT JOIN policy_notifications n ON n.id=c.id WHERE n.state IS NULL OR n.state<>'delivered'
 ) SELECT min(due) AS due,min(CASE WHEN due>(julianday('now')-2440587.5)*86400000 THEN due END) AS future FROM deadlines`).first<{due:number|null;future:number|null}>();
 if(row?.due==null) return base;
 const earlier=(a:Date|null,b:Date|null)=>!a?b:!b?a:a<b?a:b;
 return {nextAt:earlier(base.nextAt,new Date(Math.round(row.due))),nextFutureAt:earlier(base.nextFutureAt,row.future==null?null:new Date(Math.round(row.future)))};
}
