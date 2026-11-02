import { qaHandlers } from './handlers/qa';
import { requireFeature } from "../lib/deployment";
import type { Context } from "hono";
import { TRPCError } from "@trpc/server";
import type { ProcedureHandlers, TrpcContext } from "@videoq/trpc";
import * as adminService from "../features/admin/service";
import { resolveAuth, sessionMethod } from "../middleware/auth";
import { isUploadControlRequest, uploadSessionMethod } from "../middleware/upload-session-auth";
import type { AppEnv } from "../types/bindings";
import { accountHandlers } from "./handlers/account";
import { adminHandlers } from "./handlers/admin";
import { billingHandlers } from "./handlers/billing";
import { chatHandlers } from "./handlers/chat";
import { courseHandlers } from "./handlers/courses";
import { mediaLibraryHandlers } from "./handlers/media-library";
import { createRpcCaller } from "./handlers/shared";

/** Authenticate once and bind the request-scoped service adapters used by tRPC. */
export async function createTrpcContext(c: Context<AppEnv>): Promise<TrpcContext> {
  const auth = await resolveAuth(c, [isUploadControlRequest(c.req.path) ? uploadSessionMethod : sessionMethod]);
  // A rejected credential is not an anonymous request, even for public/share procedures.
  if (auth.kind === "invalid" || auth.kind === "forbidden") {
    throw new TRPCError({
      code: auth.kind === "invalid" ? "UNAUTHORIZED" : "FORBIDDEN",
      message: auth.message,
    });
  }
  const userId = auth.kind === "ok" ? auth.userId : null;

  const handlers = {
    ...accountHandlers(c, userId),
    ...adminHandlers(c, userId),
    ...billingHandlers(c, userId),
    ...chatHandlers(c, userId),
    ...courseHandlers(c, userId),
    ...qaHandlers(c, userId),
    ...mediaLibraryHandlers(c, userId),
  } satisfies ProcedureHandlers;

  return {
    userId,
    assertAdmin: async () => {
      if (userId === null || !(await adminService.isAdmin(c.env, userId))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not have permission to perform this action.",
        });
      }
    },
    call: createRpcCaller(handlers, (name) => {
      if (name.startsWith("billing.")) requireFeature(c.env, "billing");
      if (["videos.createYoutube", "account.searchApiKeyStatus", "account.saveSearchApiKey", "account.deleteSearchApiKey"].includes(name)) requireFeature(c.env, "youtube");
    }),
  };
}
