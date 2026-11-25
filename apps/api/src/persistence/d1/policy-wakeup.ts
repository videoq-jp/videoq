import type { Bindings } from '../../types/bindings';
import type { MaintenanceWakeup } from '../contracts/maintenance-repository';
import { persistenceBackend } from '../backend';
/** Due facts wake the existing scheduler; no new polling cron or service. */
export async function policyMaintenanceWakeup(env:Bindings,base:MaintenanceWakeup):Promise<MaintenanceWakeup> {
 if(persistenceBackend(env)!=='d1'||!env.DB||!env.OPERATIONAL_POLICY_WEBHOOK_URL||!env.OPERATIONAL_POLICY_WEBHOOK_TOKEN) return base;
 const row=await env.DB.prepare(`WITH deadlines(due) AS (
  SELECT (julianday(p.transcript_accepted_at)-2440587.5)*86400000+900001 FROM policy_readiness p
  WHERE p.ready_at IS NULL AND NOT EXISTS(SELECT 1 FROM policy_notifications n WHERE n.id='readiness:'||p.video_id||':'||p.source_revision AND n.state='delivered')
  UNION ALL
  SELECT (julianday(p.logical_deleted_at)-2440587.5)*86400000+CASE WHEN EXISTS(SELECT 1 FROM policy_notifications n WHERE n.id='cleanup:'||p.id||':warning' AND n.state='delivered') THEN 86400001 ELSE 3600001 END
  FROM policy_cleanup p WHERE p.completed_at IS NULL AND NOT EXISTS(SELECT 1 FROM policy_notifications n WHERE n.id='cleanup:'||p.id||':incident' AND n.state='delivered')
  UNION ALL SELECT (julianday(lease_until)-2440587.5)*86400000 FROM policy_notifications WHERE state<>'delivered' AND lease_until IS NOT NULL
 ) SELECT min(due) AS due FROM deadlines`).first<{due:number|null}>();
 if(row?.due==null) return base;
 const due=new Date(Math.round(row.due)),now=Date.now();
 const earlier=(a:Date|null,b:Date|null)=>!a?b:!b?a:a<b?a:b;
 return {nextAt:earlier(base.nextAt,due),nextFutureAt:earlier(base.nextFutureAt,due.getTime()>now?due:null)};
}
