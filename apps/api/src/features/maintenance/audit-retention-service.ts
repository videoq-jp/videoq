import type { AuditRetentionRepository, LtiAuditKind } from '../../persistence/contracts/audit-retention-repository';
const MAX_BATCHES = 20, WALL_BUDGET_MS = 25000;
export interface AuditRetentionDependencies {
  nowMs(): number;
  repository(): Promise<AuditRetentionRepository>;
  reportBacklog(result: { enabled: boolean; materialOperations: number; tagOperations: number; moderationActors: number; reportAccesses: number; backlog: boolean }): void;
}
/** Bounded pruning; repository batches retain their own atomic authorization and writes. */
export async function pruneAuditRetention(days: number | undefined, now: Date, deps: AuditRetentionDependencies) {
 const totals={materialOperations:0,tagOperations:0,moderationActors:0,reportAccesses:0};
 if(days===undefined)return {enabled:false,...totals,backlog:false};
 if(!Number.isFinite(now.getTime()))throw new Error('Invalid retention clock.');
 const cutoff=new Date(now.getTime()-days*86400000),deadline=deps.nowMs()+WALL_BUDGET_MS;
 const repository=await deps.repository();
 const pending=new Set<LtiAuditKind>(['material','tag','moderation','report']);
 for(let pass=0;pass<MAX_BATCHES&&pending.size&&deps.nowMs()<deadline;pass++){
  let progress=0;
  for(const kind of pending){
   if(deps.nowMs()>=deadline)break;
   const result=await repository.pruneBatch(kind,cutoff);
   totals[kind==='material'?'materialOperations':kind==='tag'?'tagOperations':kind==='report'?'reportAccesses':'moderationActors']+=result.count;
   progress+=result.count;if(!result.more)pending.delete(kind);
  }
  if(!progress)break;
 }
 const result={enabled:true,...totals,backlog:pending.size>0};
 if(result.backlog)deps.reportBacklog(result);
 return result;
}
