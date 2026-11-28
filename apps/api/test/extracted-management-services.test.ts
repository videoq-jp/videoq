import { extractYoutubeVideoId } from "../src/lib/youtube";
import { describe, expect, it, vi } from "vitest";
import { createAccountBillingDeletionService } from "../src/features/billing/account-deletion-service";
import type { AccountBillingDeletionDependencies } from "../src/features/billing/account-deletion-service";
import { createMembershipService } from "../src/features/membership/core";
import type { MembershipRepository } from "../src/persistence/contracts/membership-repository";
import { createVideoManagementService } from "../src/features/videos/management-service";
import type { VideoManagementDependencies } from "../src/features/videos/management-ports";

function videoFixture() {
  const deps = {
    extractYoutubeVideoId,
    list: vi
      .fn<VideoManagementDependencies["list"]>()
      .mockResolvedValue({ count: 0, results: [] }),
    detail: vi
      .fn<VideoManagementDependencies["detail"]>()
      .mockResolvedValue(null),
    createYoutube: vi
      .fn<VideoManagementDependencies["createYoutube"]>()
      .mockResolvedValue({
        videoId: 3,
        taskId: 9,
        jobId: "job",
        reused: false,
      }),
    update: vi
      .fn<VideoManagementDependencies["update"]>()
      .mockResolvedValue({ notFound: true }),
    delete: vi
      .fn<VideoManagementDependencies["delete"]>()
      .mockResolvedValue({ deleted: true, cleanupTaskId: 9 }),
    fileKey: vi
      .fn<VideoManagementDependencies["fileKey"]>()
      .mockResolvedValue({ found: true, fileKey: "videos/3" }),
    ownedBy: vi
      .fn<VideoManagementDependencies["ownedBy"]>()
      .mockResolvedValue(true),
    mapDetail: vi.fn<VideoManagementDependencies["mapDetail"]>(),
    validateTranscript: vi
      .fn<VideoManagementDependencies["validateTranscript"]>()
      .mockReturnValue(null),
    requireYoutube: vi.fn<VideoManagementDependencies["requireYoutube"]>(),
    storageBytes: vi
      .fn<VideoManagementDependencies["storageBytes"]>()
      .mockResolvedValue(4096),
    dispatch: vi
      .fn<VideoManagementDependencies["dispatch"]>()
      .mockResolvedValue(undefined),
  };
  return { deps, service: createVideoManagementService(deps) };
}

describe("video management workflows", () => {
  it.each(['q', 'status'] as const)('rejects NUL in direct list %s before persistence', async field => {
    const { deps, service } = videoFixture();
    await expect(service.listUserVideos('owner', { [field]: 'Query' + String.fromCharCode(0) + 'suffix' }, 20, 0))
      .rejects.toMatchObject({ kind: 'validation' });
    expect(deps.list).not.toHaveBeenCalled();
  });

  it("normalizes list filters without requiring a runtime", async () => {
    const { deps, service } = videoFixture();
    await service.listUserVideos(
      "owner",
      {
        q: " query ",
        status: " completed ",
        ordering: " title_asc ",
        tags: [2],
      },
      20,
      10,
    );
    expect(deps.list).toHaveBeenCalledWith(
      "owner",
      {
        keyword: "query",
        statusFilter: "completed",
        sortKey: "title_asc",
        tagIds: [2],
      },
      20,
      10,
    );
  });

  it("checks deployment capability before creating a YouTube video", async () => {
    const { deps, service } = videoFixture();
    deps.requireYoutube.mockImplementation(() => {
      throw new Error("disabled");
    });
    await expect(
      service.createUserYoutubeVideo("owner", {
        youtube_url: "https://youtu.be/abcdefghijk",
        title: "title",
        description: "",
      }),
    ).rejects.toThrow("disabled");
    expect(deps.createYoutube).not.toHaveBeenCalled();
  });

  it("rejects an invalid source before any write or task delivery", async () => {
    const { deps, service } = videoFixture();
    expect(
      await service.createUserYoutubeVideo("owner", {
        youtube_url: "https://example.com",
        title: "title",
        description: "",
      }),
    ).toHaveProperty("fieldError.youtube_url");
    expect(deps.createYoutube).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the committed creation outbox before reading the result", async () => {
    const { deps, service } = videoFixture();
    await service.createUserYoutubeVideo("owner", {
      youtube_url: "https://youtu.be/abcdefghijk",
      title: "title",
      description: "",
    });
    expect(deps.createYoutube).toHaveBeenCalledWith(
      "owner",
      {
        sourceUrl: "https://youtu.be/abcdefghijk",
        youtubeVideoId: "abcdefghijk",
        title: "title",
        description: "",
      },
      undefined,
    );
    expect(deps.createYoutube.mock.invocationCallOrder[0]).toBeLessThan(
      deps.dispatch.mock.invocationCallOrder[0],
    );
    expect(deps.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      deps.detail.mock.invocationCallOrder[0],
    );
  });

  it("does not deliver a task after an idempotency conflict", async () => {
    const { deps, service } = videoFixture();
    deps.createYoutube.mockResolvedValue({ idempotencyConflict: true });
    expect(
      await service.createUserYoutubeVideo("owner", {
        youtube_url: "https://youtu.be/abcdefghijk",
        title: "title",
        description: "",
      }),
    ).toEqual({ idempotencyConflict: true });
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.detail).not.toHaveBeenCalled();
  });

  it("does not reveal transcript validation details for an unowned video", async () => {
    const { deps, service } = videoFixture();
    deps.validateTranscript.mockReturnValue("invalid SRT");
    deps.ownedBy.mockResolvedValue(false);
    expect(
      await service.patchUserVideo(3, "other", { transcript: "invalid" }),
    ).toEqual({ notFound: true });
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("leaves authorization of valid mutations inside the atomic repository operation", async () => {
    const { deps, service } = videoFixture();
    expect(
      await service.patchUserVideo(3, "other", { title: "edited" }),
    ).toEqual({ notFound: true });
    expect(deps.update).toHaveBeenCalledWith(3, "other", { title: "edited" });
    expect(deps.ownedBy).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("retains atomic deletion and only dispatches after a successful commit", async () => {
    const { deps, service } = videoFixture();
    expect(await service.deleteUserVideo(3, "owner")).toEqual({ ok: true });
    expect(deps.delete).toHaveBeenCalledWith(3, "owner", {
      fallbackStorageBytes: 4096,
    });
    expect(deps.delete.mock.invocationCallOrder[0]).toBeLessThan(
      deps.dispatch.mock.invocationCallOrder[0],
    );
    expect(deps.dispatch).toHaveBeenCalledWith(9);
  });

  it("does not dispatch when concurrent deletion wins", async () => {
    const { deps, service } = videoFixture();
    deps.delete.mockResolvedValue({ deleted: false, cleanupTaskId: null });
    expect(await service.deleteUserVideo(3, "owner")).toEqual({
      notFound: true,
    });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});

describe("account billing deletion workflow", () => {
  function fixture(enabled = true) {
    const deps = {
    extractYoutubeVideoId,
      enabled,
      findUser: vi
        .fn<AccountBillingDeletionDependencies["findUser"]>()
        .mockResolvedValue({
          id: "owner",
          email: "owner@example.com",
          stripeCustomerId: "customer",
          stripeSubscriptionId: null,
          planCode: "free",
          subscriptionStatus: null,
          revision: "revision",
        }),
      deleteCustomer: vi
        .fn<AccountBillingDeletionDependencies["deleteCustomer"]>()
        .mockResolvedValue(undefined),
    };
    return { deps, remove: createAccountBillingDeletionService(deps) };
  }
  it("does not read billing or call the provider when disabled", async () => {
    const { deps, remove } = fixture(false);
    await remove("owner");
    expect(deps.findUser).not.toHaveBeenCalled();
    expect(deps.deleteCustomer).not.toHaveBeenCalled();
  });
  it("includes banned users and awaits provider failure so outbox retry can retain their identity", async () => {
    const { deps, remove } = fixture();
    deps.deleteCustomer.mockRejectedValue(new Error("retry"));
    await expect(remove("owner")).rejects.toThrow("retry");
    expect(deps.findUser).toHaveBeenCalledWith({ userId: "owner" });
    expect(deps.deleteCustomer).toHaveBeenCalledWith("customer");
  });
});

describe("membership workflows", () => {
  function fixture() {
    const repository = {
      attachTags: vi
        .fn<MembershipRepository["attachTags"]>()
        .mockResolvedValue({ added: 1 }),
      detachTag: vi
        .fn<MembershipRepository["detachTag"]>()
        .mockResolvedValue({ ok: true }),
      reorderVideos: vi
        .fn<MembershipRepository["reorderVideos"]>()
        .mockResolvedValue({ mismatch: true }),
      addVideosBulk: vi
        .fn<MembershipRepository["addVideosBulk"]>()
        .mockResolvedValue({ added: 1 }),
      addVideoToCourse: vi
        .fn<MembershipRepository["addVideoToCourse"]>()
        .mockResolvedValue({ alreadyIn: true, id: 5 }),
      removeVideoFromCourse: vi
        .fn<MembershipRepository["removeVideoFromCourse"]>()
        .mockResolvedValue({ notMember: true }),
    };
    return { repository, service: createMembershipService(repository) };
  }
  it("reports skipped items from the committed insertion count, including duplicates", async () => {
    const { repository, service } = fixture();
    expect(
      await service.addVideosToCourseBulk("owner", 7, [1, 2, 2]),
    ).toMatchObject({ added_count: 1, skipped_count: 2 });
    expect(repository.addVideosBulk).toHaveBeenCalledWith(
      7,
      [1, 2, 2],
      "owner",
    );
  });
  it("preserves reuse and mismatch outcomes from atomic membership operations", async () => {
    const { service } = fixture();
    expect(await service.addVideoToCourseOne("owner", 7, 3)).toMatchObject({
      id: 5,
      reused: true,
    });
    expect(await service.reorderGroupVideos("owner", 7, [3])).toHaveProperty(
      "badRequest",
    );
    expect(
      await service.removeVideoFromCourseOne("owner", 7, 3),
    ).toHaveProperty("notFound");
  });
});
