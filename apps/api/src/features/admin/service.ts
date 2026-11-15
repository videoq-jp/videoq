import type { RpcInputMap } from "@videoq/trpc";
import {
  enqueueReindexAllEmbeddings,
} from "../../lib/jobs";
import { processExternalTaskById } from "../../lib/external-tasks";
import {
  lockUserForHardDelete,
  patchAdminUserFlags,
} from "../../repositories/admin-repository";
import type { Bindings } from "../../types/bindings";

export {
  isAdmin,
  listAdminUsers as listUsers,
  getAdminUser as getUser,
  patchAdminUserQuota as patchQuota,
  patchAdminUserUsage as patchUsage,
} from "../../repositories/admin-repository";

export async function patchFlags(
  env: Bindings,
  actorUserId: string,
  targetUserId: string,
  patch: Omit<RpcInputMap["admin.patchFlags"], "id">,
  headers: Headers,
) {
  if (
    actorUserId === targetUserId &&
    (patch.is_active === false || patch.is_admin === false)
  ) {
    return { selfLockout: true as const };
  }

  const user = await patchAdminUserFlags(env,actorUserId,targetUserId,patch,headers);
  return user ? { user } as const : { notFound: true as const };
}

export async function enqueueReindexAll(env: Bindings) {
  const jobId = await enqueueReindexAllEmbeddings(env);
  return { job_id: jobId } as const;
}

export async function deleteUser(
  env: Bindings,
  actorUserId: string,
  targetUserId: string,
) {
  if (actorUserId === targetUserId) {
    return { self: true } as const;
  }
  const locked = await lockUserForHardDelete(env, targetUserId);
  if (!("taskId" in locked)) return locked;
  await processExternalTaskById(env, locked.taskId);
  return { job_id: locked.jobId } as const;
}
