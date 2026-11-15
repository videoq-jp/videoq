export type LtiAuditKind='material'|'tag'|'moderation'|'report';
export const LTI_AUDIT_BATCH_SIZE=500;
export interface AuditRetentionRepository{pruneBatch(kind:LtiAuditKind,cutoff:Date):Promise<{count:number;more:boolean}>;}
