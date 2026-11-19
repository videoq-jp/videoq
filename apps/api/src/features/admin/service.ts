import type { AdminFlagsPatch } from '../../application/admin';
import { adminService } from '../../integrations/admin';
import type { Bindings } from '../../types/bindings';

export {
  isAdmin,
  listAdminUsers as listUsers,
  getAdminUser as getUser,
  patchAdminUserQuota as patchQuota,
  patchAdminUserUsage as patchUsage,
} from '../../repositories/admin-repository';

// Compatibility boundary for existing transports; decisions live in core.ts.
export function patchFlags(env: Bindings, actorId: string, targetId: string, patch: AdminFlagsPatch, headers: Headers) {
  return adminService(env, headers).patchFlags(actorId, targetId, patch);
}
export function enqueueReindexAll(env: Bindings) {
  return adminService(env).enqueueReindexAll();
}
export function deleteUser(env: Bindings, actorId: string, targetId: string) {
  return adminService(env).deleteUser(actorId, targetId);
}
