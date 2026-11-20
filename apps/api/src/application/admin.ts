/** Application-owned administration commands; RPC schemas are checked separately. */
export type AdminFlagsPatch = { is_active?: boolean; is_admin?: boolean };
export type AdminDeleteResult = { notFound: true } | { forbiddenAdmin: true } | { taskId: number; jobId: string };

export type AdminQuotaPatch = {
  monthly_upload_limit_gb?: number | null; storage_limit_gb?: number | null;
  processing_limit_minutes?: number | null; ai_answers_limit?: number | null;
  quota_source?: 'plan' | 'admin';
};
export type AdminUsagePatch = {
  used_storage_bytes?: number; used_processing_seconds?: number; used_ai_answers?: number;
  usage_period_start?: string | null; is_over_quota?: boolean;
};

/** Only the two supported account roles may be assigned. Existing administrators
 * cannot demote themselves through either the native auth API or the app API. */
export function adminRoleChangeFailure(
  role: unknown, actorId: string | undefined, targetId: string | undefined,
): string | undefined {
  if (role === undefined) return;
  if (role !== 'user' && role !== 'admin') return 'Role must be user or admin.';
  if (actorId !== undefined && targetId === actorId && role !== 'admin') {
    return 'Cannot remove your own administrator role.';
  }
}

export function adminSelfLockout(actorId: string, targetId: string, patch: AdminFlagsPatch): boolean {
  return actorId === targetId && (patch.is_active === false || patch.is_admin === false);
}
export function adminAssignedRole(administrator: boolean): 'admin' | 'user' {
  return administrator ? 'admin' : 'user';
}
export function adminRoleIncludes<Role, Predicate>(role: Role,
  logic: { includes(role: Role, expected: 'admin'): Predicate }): Predicate {
  return logic.includes(role, 'admin');
}
export const adminBooleanRoleLogic = {
  includes: (role: string | null | undefined, expected: 'admin') => role?.split(',').includes(expected) ?? false,
};
export function adminDeletionAllowed<Predicate>(administrator: Predicate, logic: { not(value: Predicate): Predicate }): Predicate {
  return logic.not(administrator);
}

export type AdminQuotaEdit = { kind: 'restorePlan' } | { kind: 'unchanged' } | { kind: 'manual'; fields: {
  monthlyUploadLimitGb?: number | null; storageLimitGb?: number | null;
  processingLimitMinutes?: number | null; aiAnswersLimit?: number | null; quotaSource: 'admin';
} };
/** Explicit plan restoration wins over supplied manual limits. Even zero or
 * unlimited null is a manual override; absent fields must not change source. */
export function planAdminQuotaEdit(patch: AdminQuotaPatch): AdminQuotaEdit {
  if (patch.quota_source === 'plan') return { kind: 'restorePlan' };
  const fields: Omit<Extract<AdminQuotaEdit, {kind:'manual'}>['fields'], 'quotaSource'> = {};
  if (patch.monthly_upload_limit_gb !== undefined) fields.monthlyUploadLimitGb = patch.monthly_upload_limit_gb;
  if (patch.storage_limit_gb !== undefined) fields.storageLimitGb = patch.storage_limit_gb;
  if (patch.processing_limit_minutes !== undefined) fields.processingLimitMinutes = patch.processing_limit_minutes;
  if (patch.ai_answers_limit !== undefined) fields.aiAnswersLimit = patch.ai_answers_limit;
  if (patch.quota_source === undefined && Object.keys(fields).length === 0) return { kind: 'unchanged' };
  return { kind: 'manual', fields: { ...fields, quotaSource: 'admin' } };
}
