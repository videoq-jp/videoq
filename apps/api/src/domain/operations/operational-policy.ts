/** Initial targets delegated in #1684 on 2026-11-25; not measured guarantees. */
export const OPERATIONAL_POLICY = Object.freeze({ decidedAt: '2026-11-25', owner: 'yukiharada1228', reviewDue: '2026-12-02',
  searchableMs: 15 * 60 * 1000, cleanupNotifyMs: 60 * 60 * 1000, cleanupIncidentMs: 24 * 60 * 60 * 1000 });
export type ReadinessObservation = {id:string;currentRevision:string;transcriptAcceptedAt:string;readyRevision?:string;readyAt?:string|null};
export type CleanupObservation = {id:string;scope:'active-object'|'active-index'|'backup';logicalDeletedAt:string;completedAt?:string|null};
export type PolicySnapshot = {observedAt:string;readiness:ReadinessObservation[];cleanup:CleanupObservation[]};
export type PolicyEvent = {kind:string;id:string;severity:'warning'|'incident';ageMs:number;owner:string;policyDate:string};
function time(value:string) { const result=Date.parse(value); if (!Number.isFinite(result)) throw Error('Invalid timestamp'); return result; }
export function evaluateOperationalPolicy(snapshot:PolicySnapshot) {
  if (!snapshot || !Array.isArray(snapshot.readiness) || !Array.isArray(snapshot.cleanup)) throw Error('Expected readiness and cleanup arrays');
  const now=time(snapshot.observedAt), events:PolicyEvent[]=[];
  const emit=(kind:string,row:{id:string},severity:PolicyEvent['severity'],ageMs:number)=>events.push({kind,id:row.id,severity,ageMs,owner:OPERATIONAL_POLICY.owner,policyDate:OPERATIONAL_POLICY.decidedAt});
  for (const row of snapshot.readiness) {
    if(typeof row.id!=='string'||typeof row.currentRevision!=='string'||!row.currentRevision) throw Error('Invalid readiness identity');
    const accepted=time(row.transcriptAcceptedAt); if(accepted>now) throw Error('Future acceptance');
    const ready=row.readyRevision===row.currentRevision && row.readyAt ? time(row.readyAt) : null;
    if(ready!==null&&(ready<accepted||ready>now)) throw Error('Invalid ready timestamp');
    const age=(ready??now)-accepted;
    if(age>OPERATIONAL_POLICY.searchableMs) emit(ready===null?'search_readiness_overdue':'search_readiness_target_missed',row,'warning',age);
  }
  for (const row of snapshot.cleanup) {
    if(typeof row.id!=='string'||!['active-object','active-index','backup'].includes(row.scope)) throw Error('Invalid cleanup identity/scope');
    if(row.scope==='backup') continue;
    const deleted=time(row.logicalDeletedAt); if(deleted>now) throw Error('Future deletion');
    const completed=row.completedAt ? time(row.completedAt) : null;
    if(completed!==null&&(completed<deleted||completed>now)) throw Error('Invalid cleanup completion');
    const age=(completed??now)-deleted;
    if(age>OPERATIONAL_POLICY.cleanupIncidentMs) emit(completed===null?'active_cleanup_incident':'active_cleanup_target_missed',row,'incident',age);
    else if(age>OPERATIONAL_POLICY.cleanupNotifyMs && completed===null) emit('active_cleanup_overdue',row,'warning',age);
  }
  return {policy:OPERATIONAL_POLICY,observedAt:snapshot.observedAt,events,notificationDelivery:'not performed by evaluator'};
}
