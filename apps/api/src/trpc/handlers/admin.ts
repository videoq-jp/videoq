import { inspectSearchWorkflowRecovery, recoverSearchWorkflow } from '../../integrations/background-jobs/recovery';
import { provisionOnpremUser, resetOnpremUserAccess } from "../../features/admin/onprem-users";
import type { Context } from "hono";
import * as adminService from "../../features/admin/service";
import type { AppEnv } from "../../types/bindings";
import { requireUserId, rpcError, type HandlersFor } from "./shared";

export function adminHandlers(
  c: Context<AppEnv>,
  authenticatedUserId: string | null,
): HandlersFor<"admin"> {
  const actorId = () => requireUserId(authenticatedUserId);
  return {
    'admin.inspectSearchRecovery': async ({job}) => inspectSearchWorkflowRecovery(c.env,job,new URL(c.req.url).origin),
    'admin.restartSearchWorkflow': async ({job,inspection}) => recoverSearchWorkflow(c.env,job,inspection,new URL(c.req.url).origin,actorId()),
    "admin.createUser": async (input) => provisionOnpremUser(c.env, input, c.req.raw.headers),
    "admin.resetAccess": async ({ id }) => resetOnpremUserAccess(c.env, id),
    "admin.listUsers": async ({ q, limit, offset }) => {
      const { count, results } = await adminService.listUsers(
        c.env,
        q?.trim() ?? "",
        limit,
        offset,
      );
      return { data: results, meta: { total: count, limit, offset } };
    },
    "admin.getUser": async ({ id }) => {
      const user = await adminService.getUser(c.env, id);
      if (!user) return rpcError("NOT_FOUND", "User not found");
      return user;
    },
    "admin.patchQuota": async ({ id, ...patch }) => {
      const user = await adminService.patchQuota(c.env, id, patch);
      if (!user) return rpcError("NOT_FOUND", "User not found");
      return user;
    },
    "admin.patchUsage": async ({ id, ...patch }) => {
      const user = await adminService.patchUsage(c.env, id, patch);
      if (!user) return rpcError("NOT_FOUND", "User not found");
      return user;
    },
    "admin.patchFlags": async ({ id, ...patch }) => {
      const result = await adminService.patchFlags(c.env, actorId(), id, patch, c.req.raw.headers);
      if ("notFound" in result) return rpcError("NOT_FOUND", "User not found");
      if ("selfLockout" in result) {
        return rpcError(
          "BAD_REQUEST",
          "Cannot deactivate yourself or remove your own administrator role.",
        );
      }
      return result.user;
    },
    "admin.deleteUser": async ({ id }) => {
      const result = await adminService.deleteUser(c.env, actorId(), id);
      if ("self" in result) return rpcError("BAD_REQUEST", "Cannot delete your own account via Admin.");
      if ("notFound" in result) return rpcError("NOT_FOUND", "User not found");
      if ("forbiddenAdmin" in result) return rpcError("FORBIDDEN", "Cannot delete another administrator.");
      return { job_id: result.job_id };
    },
    "admin.reindexAll": async () => {
      const result = await adminService.enqueueReindexAll(c.env);
      return { job_id: result.job_id };
    },
  };
}
