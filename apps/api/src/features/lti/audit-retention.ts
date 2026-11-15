import {createAuditRetentionRepository} from '../../persistence/factory';
import type {LtiAuditKind} from '../../persistence/contracts/audit-retention-repository';
import type {Bindings} from '../../types/bindings';
import {ltiConfig} from './config';
const MAX_BATCHES=20,WALL_BUDGET_MS=25000;
/** Operator opt-in; shared teaching content and native moderation actors are untouched. */
export async function pruneLtiAudit(env:Bindings,now=new Date()){
 const days=ltiConfig(env)?.auditRetentionDays;
 const totals={materialOperations:0,tagOperations:0,moderationActors:0,reportAccesses:0};
 if(days===undefined)return {enabled:false,...totals,backlog:false};
 if(!Number.isFinite(now.getTime()))throw new Error('Invalid retention clock.');
 const cutoff=new Date(now.getTime()-days*86400000),deadline=Date.now()+WALL_BUDGET_MS;
 const repository=await createAuditRetentionRepository(env);
 const pending=new Set<LtiAuditKind>(['material','tag','moderation','report']);
 for(let pass=0;pass<MAX_BATCHES&&pending.size&&Date.now()<deadline;pass++){
  let progress=0;
  for(const kind of pending){
   if(Date.now()>=deadline)break;
   const result=await repository.pruneBatch(kind,cutoff);
   totals[kind==='material'?'materialOperations':kind==='tag'?'tagOperations':kind==='report'?'reportAccesses':'moderationActors']+=result.count;
   progress+=result.count;if(!result.more)pending.delete(kind);
  }
  if(!progress)break;
 }
 const result={enabled:true,...totals,backlog:pending.size>0};
 if(result.backlog)console.warn(JSON.stringify({event:'lti_audit_retention_backlog',...result}));
 return result;
}
