import type {CleanupObservation,ReadinessObservation} from '../../application/operational-policy';
import type {OperationalPolicyRepository} from '../contracts/operational-policy';
/** All observations/leases stay in the same D1 authority as the lifecycle facts. */
export function createD1OperationalPolicyRepository(database:D1Database):OperationalPolicyRepository {
 return {
 async read(observedAt) {
  const readiness=(await database.prepare(`SELECT CAST(p.video_id AS text)||':'||p.source_revision AS id,p.source_revision AS currentRevision,p.transcript_accepted_at AS transcriptAcceptedAt,p.source_revision AS readyRevision,p.ready_at AS readyAt
    FROM policy_readiness p JOIN video_index_versions v ON p.video_id=v.video_id AND p.source_revision=v.revision
    WHERE ((julianday(coalesce(p.ready_at,?))-julianday(p.transcript_accepted_at))*86400000)>900000 AND NOT EXISTS(SELECT 1 FROM policy_notifications n WHERE n.id='readiness:'||p.video_id||':'||p.source_revision AND n.state='delivered') ORDER BY p.transcript_accepted_at LIMIT 100`).bind(observedAt).all<ReadinessObservation>()).results;
  const cleanup=(await database.prepare(`SELECT p.id,p.scope,p.logical_deleted_at AS logicalDeletedAt,p.completed_at AS completedAt FROM policy_cleanup p
    WHERE ((p.completed_at IS NULL AND (julianday(?)-julianday(p.logical_deleted_at))*86400000>3600000) OR (p.completed_at IS NOT NULL AND (julianday(p.completed_at)-julianday(p.logical_deleted_at))*86400000>86400000)) AND NOT EXISTS(SELECT 1 FROM policy_notifications n WHERE n.id='cleanup:'||p.id||':incident' AND n.state='delivered') AND (p.completed_at IS NOT NULL OR (julianday(?)-julianday(p.logical_deleted_at))*86400000>86400000 OR NOT EXISTS(SELECT 1 FROM policy_notifications n WHERE n.id='cleanup:'||p.id||':warning' AND n.state='delivered')) ORDER BY p.logical_deleted_at LIMIT 100`).bind(observedAt,observedAt).all<CleanupObservation>()).results;
return {observedAt,readiness,cleanup};
},
async claim(id,severity) {
    const lease=await database.prepare(`INSERT INTO policy_notifications(id,severity,state,attempts,lease_until) VALUES(?,?,'sending',1,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute'))
      ON CONFLICT(id) DO UPDATE SET state='sending',attempts=attempts+1,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute')
      WHERE policy_notifications.state<>'delivered' AND (policy_notifications.lease_until IS NULL OR julianday(policy_notifications.lease_until)<=julianday('now')) RETURNING attempts`).bind(id,severity).first<{attempts:number}>();
return lease?.attempts??null;
},
async settle(id,attempt,delivered) {
 if(delivered) {
const result=await database.prepare("UPDATE policy_notifications SET state='delivered',delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_until=NULL WHERE id=? AND state='sending' AND attempts=?").bind(id,attempt).run();
return (result.meta.changes??0)>0;
} else {
const result=await database.prepare("UPDATE policy_notifications SET state='pending',lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=? AND state='sending' AND attempts=?").bind(id,attempt).run();
return (result.meta.changes??0)>0;
}
}
};
}
