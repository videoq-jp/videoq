export interface JobReclaimLogic<T> { and(...terms: T[]): T; or(...terms: T[]): T }
export function jobReclaimAllowed<T>(facts: { sameIdentity: T; notCompleted: T; notRunning: T; noLease: T; expired: T }, logic: JobReclaimLogic<T>): T {
  return logic.and(facts.sameIdentity, facts.notCompleted, logic.or(facts.notRunning, facts.noLease, facts.expired));
}
export function jobClaimRefusal(sameIdentity: boolean, status: string): 'conflict' | 'completed' | 'busy' {
  return !sameIdentity ? 'conflict' : status === 'completed' ? 'completed' : 'busy';
}
export function jobClaimDecision(sameIdentity: boolean, status: string, leaseActive: boolean): 'conflict' | 'completed' | 'busy' | 'claimable' {
  const refusal = jobClaimRefusal(sameIdentity, status);
  if (refusal !== 'busy') return refusal;
  return jobReclaimAllowed({ sameIdentity, notCompleted: true, notRunning: status !== 'running', noLease: false, expired: !leaseActive },
    { and: (...terms) => terms.every(Boolean), or: (...terms) => terms.some(Boolean) }) ? 'claimable' : 'busy';
}

export type JobLeaseOperation = 'complete' | 'fail' | 'heartbeat';
/** Completion/failure fence by token; heartbeat additionally requires live time. */
export function jobLeaseMutationAllowed<T>(operation: JobLeaseOperation, facts: { running: T; tokenMatches: T; leaseActive: T }, logic: Pick<JobReclaimLogic<T>, 'and'>): T {
  return logic.and(facts.running, facts.tokenMatches, ...(operation === 'heartbeat' ? [facts.leaseActive] : []));
}
