import { describe, expect, it, vi } from "vitest";
import { appRouter, type TrpcContext } from "@videoq/trpc";
import { createApp } from "../src/app";

const EXPECTED_PROCEDURES = [
  "account.connectedApps",
  "account.deleteSearchApiKey",
  "account.integrationApiKeys",
  "account.me",
  "account.saveSearchApiKey",
  "account.searchApiKeyStatus",
  "admin.createUser",
  "admin.deleteUser",
  "admin.getUser",
  "admin.listUsers",
  "admin.patchFlags",
  "admin.patchQuota",
  "admin.patchUsage",
  "admin.reindexAll",
  "admin.resetAccess",
  "billing.checkout",
  "billing.plans",
  "billing.portal",
  "chat.analytics",
  "chat.conversation",
  "chat.conversations",
  "chat.deleteConversation",
  "chat.feedback",
  "chat.history",
  "chat.resetHistory",
  "chat.send",
  "courseMemberships.accept",
  "courseMemberships.decline",
  "courseMemberships.invite",
  "courseMemberships.leave",
  "courseMemberships.participants",
  "courseMemberships.preview",
  "courseMemberships.removeMember",
  "courseMemberships.resend",
  "courseMemberships.revoke",
  "courses.create",
  "courses.createShare",
  "courses.delete",
  "courses.deleteShare",
  "courses.get",
  "courses.list",
  "courses.reorder",
  "courses.shared",
  "courses.update",
  "memberships.addTags",
  "memberships.addVideo",
  "memberships.addVideos",
  "memberships.removeTag",
  "memberships.removeVideo",
  "memberships.reorderVideos",
  "tags.create",
  "tags.delete",
  "tags.get",
  "tags.list",
  "tags.update",
  "videos.abortUpload",
  "videos.completeMultipartUpload",
  "videos.confirmUpload",
  "videos.createYoutube",
  "videos.delete",
  "videos.get",
  "videos.list",
  "videos.requestUpload",
  "videos.statusCounts",
  "videos.update",
  "videos.uploadPartUrl",
] as const;

const ENV = { ENVIRONMENT: "test" } as CloudflareBindings;

describe("tRPC public surface", () => {
  it("keeps every application procedure in the shared router", () => {
    expect(Object.keys(appRouter._def.procedures).sort()).toEqual(EXPECTED_PROCEDURES);
  });

  it("mounts every shared procedure through the Hono tRPC adapter", async () => {
    const app = createApp();

    for (const [path, procedure] of Object.entries(appRouter._def.procedures)) {
      // Use the opposite HTTP method so tRPC proves that it recognized the
      // procedure without invoking an application handler or external service.
      const method = procedure._def.type === "query" ? "POST" : "GET";
      const response = await app.request(
        `/api/trpc/${path}`,
        method === "POST"
          ? {
              method,
              headers: { "content-type": "application/json" },
              body: "{}",
            }
          : { method },
        ENV,
      );
      expect(response.status, path).toBe(405);
    }
  });

  it("requires a browser session for protected writes", async () => {
    const caller = appRouter.createCaller({
      userId: null,
      assertAdmin: async () => undefined,
      call: async () => ({ deleted: 0 }),
    } as TrpcContext);

    await expect(caller.chat.resetHistory({ courseId: 1 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("requires authentication for every multipart control operation", async () => {
    const call = vi.fn();
    const caller = appRouter.createCaller({ userId: null, assertAdmin: async () => undefined, call });
    await expect(caller.videos.uploadPartUrl({ id: 1, partNumber: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.videos.completeMultipartUpload({ id: 1, parts: [{ partNumber: 1, etag: "a".repeat(32) }] })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.videos.abortUpload({ id: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(call).not.toHaveBeenCalled();
  });
  it.each(["integrationApiKeys", "connectedApps"] as const)("requires a browser session before reading account.%s", async (procedure) => {
    const call = vi.fn();
    const caller = appRouter.createCaller({ userId: null, assertAdmin: async () => undefined, call });
    await expect(caller.account[procedure]()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(call).not.toHaveBeenCalled();
  });

});
