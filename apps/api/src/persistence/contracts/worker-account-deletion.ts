export type AccountDeletionLease={userId:string;jobId:string;leaseToken:string};
export type AccountDeletionStep={status:'progress'|'completed'|'denied'};
export interface WorkerAccountDeletion {step(lease:AccountDeletionLease):Promise<AccountDeletionStep>}
