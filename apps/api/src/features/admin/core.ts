import { adminSelfLockout, type AdminDeleteResult, type AdminFlagsPatch } from '../../domain/identity/admin';

export interface AdminDependencies<User> {
  patchFlags(actorId: string, targetId: string, patch: AdminFlagsPatch): Promise<User | null>;
  lockForHardDelete(userId: string): Promise<AdminDeleteResult>;
  processDeletion(taskId: number): Promise<unknown>;
  enqueueReindexAll(): Promise<string>;
}

/** Authorization and mutation remain atomic inside the supplied repository. */
export function createAdminService<User>(deps: AdminDependencies<User>) {
  return {
    async patchFlags(actorId: string, targetId: string, patch: AdminFlagsPatch) {
      if (adminSelfLockout(actorId, targetId, patch)) {
        return { selfLockout: true as const };
      }
      const user = await deps.patchFlags(actorId, targetId, patch);
      return user ? { user } as const : { notFound: true as const };
    },
    async enqueueReindexAll() {
      return { job_id: await deps.enqueueReindexAll() };
    },
    async deleteUser(actorId: string, targetId: string) {
      if (actorId === targetId) return { self: true as const };
      const locked = await deps.lockForHardDelete(targetId);
      if (!('taskId' in locked)) return locked;
      await deps.processDeletion(locked.taskId);
      return { job_id: locked.jobId };
    },
  };
}
