import { createVideoFromMultipart } from "../src/features/videos/upload-http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const videoRepository = vi.hoisted(() => ({
  getVideoUploadState: vi.fn(),
  getVideoFileKey: vi.fn(),
  confirmUploadedVideo: vi.fn(),
  getVideoDetail: vi.fn(),
  mapVideoDetailRow: vi.fn(),
  reserveAndCreatePendingVideo: vi.fn(),
  deleteVideoCascade: vi.fn(),
  updateVideo: vi.fn(),
}));
const media = vi.hoisted(() => ({
  isS3Storage: vi.fn(),
  presignR2Put: vi.fn(),
  putMediaObject: vi.fn(),
  getR2ObjectSize: vi.fn(),
}));
const externalTasks = vi.hoisted(() => ({
  processExternalTaskById: vi.fn(),
}));

vi.mock("../src/repositories/video-repository", () => videoRepository);
vi.mock("../src/integrations/media", () => media);
vi.mock("../src/lib/external-tasks", () => ({
  processExternalTaskById: externalTasks.processExternalTaskById,
}));
vi.mock("../src/repositories/membership-repository", () => ({
  videoOwnedBy: vi.fn(),
}));

import {
  patchUserVideo,
  confirmVideoUpload,
  deleteUserVideo,
  requestPresignedUpload,
} from "../src/features/videos/service";
import { videoOwnedBy } from "../src/repositories/membership-repository";

const env = { USE_S3_STORAGE: "true" } as never;
const userId = "00000000-0000-4000-8000-000000000005";

beforeEach(() => {
  vi.clearAllMocks();
  videoRepository.reserveAndCreatePendingVideo.mockResolvedValue({
    ok: true,
    videoId: 42,
    fileKey: "videos/5/video_1700000000000_4096.mp4",
    reused: false,
  });
  media.isS3Storage.mockReturnValue(true);
  media.presignR2Put.mockResolvedValue("https://upload.test/");
  media.putMediaObject.mockResolvedValue(undefined);
  media.getR2ObjectSize.mockResolvedValue(4096);
  videoRepository.getVideoDetail.mockResolvedValue({ id: 42 });
  videoRepository.mapVideoDetailRow.mockResolvedValue({ id: 42 });
  videoRepository.getVideoFileKey.mockResolvedValue({
    found: true,
    fileKey: "videos/5/video_1700000000000_4096.mp4",
  });
  videoRepository.deleteVideoCascade.mockResolvedValue({
    deleted: true,
    cleanupTaskId: 77,
  });
  externalTasks.processExternalTaskById.mockResolvedValue(true);
  videoRepository.updateVideo.mockResolvedValue({ row: { id: 42 }, reindexTaskId: null });
  vi.mocked(videoOwnedBy).mockResolvedValue(true);
});

describe("動画処理の原子性", () => {
  it("does not log private cleanup diagnostics when upload signing also fails", async () => {
    const canary = "synthetic-private-upload-cleanup-SQL-token";
    media.presignR2Put.mockRejectedValueOnce(new Error("sign failed"));
    videoRepository.deleteVideoCascade.mockRejectedValueOnce(new Error(canary));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(requestPresignedUpload(env, userId, {
        filename: "clip.mp4", content_type: "video/mp4", file_size: 4096, title: "clip", description: "",
      })).rejects.toThrow("sign failed");
      expect(log.mock.calls.filter(call => String(call[0]).includes("presigned_upload_cleanup"))).toHaveLength(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    } finally { log.mockRestore(); }
  });

  it("update metadata updates rely on the atomic ownership check", async () => {
    const fields = { title: "Edited", description: "Updated description" };
    expect(await patchUserVideo(env, 42, userId, fields)).toEqual({ video: { id: 42 } });
    expect(videoOwnedBy).not.toHaveBeenCalled();
    expect(videoRepository.updateVideo).toHaveBeenCalledExactlyOnceWith(env, 42, userId, fields);
    expect(videoRepository.getVideoDetail).not.toHaveBeenCalled();
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it("update does not reload missing or foreign videos", async () => {
    videoRepository.updateVideo.mockResolvedValue({ notFound: true });
    expect(await patchUserVideo(env, 42, userId, { title: "Edited", description: "" })).toEqual({ notFound: true });
    expect(videoOwnedBy).not.toHaveBeenCalled();
    expect(videoRepository.getVideoDetail).not.toHaveBeenCalled();
  });

  it("keeps subtitle validation errors behind ownership checks", async () => {
    vi.mocked(videoOwnedBy).mockResolvedValueOnce(false);
    expect(await patchUserVideo(env, 42, userId, { transcript: "invalid" })).toEqual({ notFound: true });
    expect(await patchUserVideo(env, 42, userId, { transcript: "invalid" })).toHaveProperty("fieldError.transcript");
    expect(videoRepository.updateVideo).not.toHaveBeenCalled();
  });

  it("dispatches a committed subtitle reindex and returns the saved video without reloading", async () => {
    videoRepository.updateVideo.mockResolvedValue({ row: { id: 42 }, reindexTaskId: 79 });
    expect(await patchUserVideo(env, 42, userId, { transcript: "" })).toEqual({ video: { id: 42 } });
    expect(videoOwnedBy).not.toHaveBeenCalled();
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledExactlyOnceWith(env, 79);
    expect(videoRepository.updateVideo.mock.invocationCallOrder[0]).toBeLessThan(externalTasks.processExternalTaskById.mock.invocationCallOrder[0]);
    expect(videoRepository.getVideoDetail).not.toHaveBeenCalled();
    expect(externalTasks.processExternalTaskById.mock.invocationCallOrder[0]).toBeLessThan(videoRepository.mapVideoDetailRow.mock.invocationCallOrder[0]);
  });

  it("動画削除は予約済み容量を使い、不要なサイズ確認をしない", async () => {
    media.getR2ObjectSize.mockResolvedValue(8192);
    await expect(deleteUserVideo(env, 42, userId)).resolves.toEqual({ ok: true });
    expect(media.getR2ObjectSize).not.toHaveBeenCalled();
    expect(videoRepository.deleteVideoCascade).toHaveBeenCalledWith(env, 42, userId, {
      fallbackStorageBytes: 4096,
    });
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledWith(env, 77);
  });

  it.each([false, true])("旧形式の動画削除はサイズ取得失敗=%sでも削除を続ける", async failure => {
    const fileKey = "videos/5/video_1700000000000.mp4";
    videoRepository.getVideoFileKey.mockResolvedValue({ found: true, fileKey });
    if (failure) media.getR2ObjectSize.mockRejectedValue(new Error("Storage unavailable"));
    await expect(deleteUserVideo(env, 42, userId)).resolves.toEqual({ ok: true });
    expect(media.getR2ObjectSize).toHaveBeenCalledExactlyOnceWith(env, fileKey);
    expect(videoRepository.deleteVideoCascade).toHaveBeenCalledWith(env, 42, userId, {
      fallbackStorageBytes: failure ? null : 4096,
    });
  });

  it("uploading→pending の遷移に負けた確認リクエストはジョブを投入しない", async () => {
    videoRepository.getVideoUploadState.mockResolvedValue({ found: true, status: "uploading", fileKey: "videos/5/video_1700000000000_4096.mp4" });
    videoRepository.confirmUploadedVideo.mockResolvedValue(false);

    const result = await confirmVideoUpload(env, 42, userId);

    expect(result).toMatchObject({ badState: true });
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it("並行確認に負けても相手がpendingへ進めていれば成功として再利用する", async () => {
    videoRepository.getVideoUploadState
      .mockResolvedValueOnce({ found: true, status: "uploading", fileKey: "videos/5/video_1700000000000_4096.mp4" })
      .mockResolvedValueOnce({ found: true, status: "pending", fileKey: "videos/5/video_1700000000000_4096.mp4" });
    videoRepository.confirmUploadedVideo.mockResolvedValue(false);

    await expect(confirmVideoUpload(env, 42, userId)).resolves.toMatchObject({
      video: { id: 42 },
      alreadyConfirmed: true,
    });
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it("uploading→pending と同じtransactionで保存した配送taskを実行する", async () => {
    videoRepository.getVideoUploadState.mockResolvedValue({ found: true, status: "uploading", fileKey: "videos/5/video_1700000000000_4096.mp4" });
    videoRepository.confirmUploadedVideo.mockResolvedValue({
      videoId: 42,
      taskId: 79,
      jobId: "job-79",
    });

    await expect(confirmVideoUpload(env, 42, userId)).resolves.toMatchObject({
      video: { id: 42 },
    });
    expect(videoRepository.confirmUploadedVideo).toHaveBeenCalledExactlyOnceWith(
      env, 42, userId, "videos/5/video_1700000000000_4096.mp4",
    );
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledWith(env, 79);
  });

  it("アップロード実サイズが予約と違えば削除した勝者だけが予約を返却する", async () => {
    videoRepository.getVideoUploadState.mockResolvedValue({ found: true, status: "uploading", fileKey: "videos/5/video_1700000000000_4096.mp4" });
    media.getR2ObjectSize.mockResolvedValue(8192);

    const result = await confirmVideoUpload(env, 42, userId);

    expect(result).toMatchObject({ badState: true });
    expect(videoRepository.deleteVideoCascade).toHaveBeenCalledWith(
      env,
      42,
      userId,
      { expectedStatus: "uploading", expectedFileKey: "videos/5/video_1700000000000_4096.mp4", fallbackStorageBytes: 4096 },
    );
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledWith(env, 77);
    expect(videoRepository.confirmUploadedVideo).not.toHaveBeenCalled();
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledTimes(1);
  });

  it("オブジェクト未着では確定もジョブ投入もしない", async () => {
    videoRepository.getVideoUploadState.mockResolvedValue({ found: true, status: "uploading", fileKey: "videos/5/video_1700000000000_4096.mp4" });
    media.getR2ObjectSize.mockResolvedValue(null);

    const result = await confirmVideoUpload(env, 42, userId);

    expect(result).toMatchObject({ badState: true });
    expect(videoRepository.confirmUploadedVideo).not.toHaveBeenCalled();
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it("容量予約とpending動画作成は同じtransactionで失敗する", async () => {
    videoRepository.reserveAndCreatePendingVideo.mockRejectedValue(
      new Error("db down"),
    );

    await expect(
      requestPresignedUpload(env, userId, {
        filename: "clip.mp4",
        content_type: "video/mp4",
        file_size: 4096,
        title: "clip",
        description: "",
      }),
    ).rejects.toThrow("db down");
    expect(videoRepository.deleteVideoCascade).not.toHaveBeenCalled();
    expect(externalTasks.processExternalTaskById).not.toHaveBeenCalled();
  });

  it("署名URL作成に失敗したらpending動画を削除した勝者だけが容量を返却する", async () => {
    media.presignR2Put.mockRejectedValue(new Error("sign failed"));

    await expect(
      requestPresignedUpload(env, userId, {
        filename: "clip.mp4",
        content_type: "video/mp4",
        file_size: 4096,
        title: "clip",
        description: "",
      }),
    ).rejects.toThrow("sign failed");
    expect(videoRepository.deleteVideoCascade).toHaveBeenCalledWith(
      env,
      42,
      userId,
      { expectedStatus: "uploading", expectedFileKey: "videos/5/video_1700000000000_4096.mp4", fallbackStorageBytes: 4096 },
    );
    expect(media.presignR2Put).toHaveBeenCalledWith(
      env,
      expect.stringContaining("_4096.mp4"),
      "video/mp4",
      4096,
    );
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledWith(env, 77);
  });

  it("確定済みアップロードの再試行では上書き可能な署名URLを再発行しない", async () => {
    videoRepository.reserveAndCreatePendingVideo.mockResolvedValue({
      ok: true,
      videoId: 42,
      fileKey: "videos/5/video_1700000000000_4096.mp4",
      reused: true,
    });
    videoRepository.getVideoDetail.mockResolvedValue({
      id: 42,
      status: "processing",
    });

    await expect(
      requestPresignedUpload(
        env,
        userId,
        {
          filename: "clip.mp4",
          content_type: "video/mp4",
          file_size: 4096,
          title: "clip",
          description: "",
        },
        {
          action: "request_video_upload",
          key: "upload-clip-1",
          requestHash: "a".repeat(64),
        },
      ),
    ).resolves.toMatchObject({
      video: { id: 42, status: "processing" },
      upload_url: null,
      reused: true,
      already_confirmed: true,
    });
    expect(media.presignR2Put).not.toHaveBeenCalled();
  });

  it("multipartのR2保存失敗時は先に作った動画と容量を耐久taskで戻す", async () => {
    media.isS3Storage.mockReturnValue(false);
    media.putMediaObject.mockRejectedValue(new Error("R2 down"));
    const file = new File(["abcd"], "clip.mp4", { type: "video/mp4" });

    const result = await createVideoFromMultipart(env, userId, {
      file,
      title: "clip",
      description: "",
    });

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(videoRepository.deleteVideoCascade).toHaveBeenCalledWith(
      env,
      42,
      userId,
      { expectedStatus: "uploading", expectedFileKey: media.putMediaObject.mock.calls[0][1], fallbackStorageBytes: 4 },
    );
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledWith(env, 77);
  });

  it("multipart confirmation is scoped to the owner and the stored file", async () => {
    media.isS3Storage.mockReturnValue(false);
    videoRepository.confirmUploadedVideo.mockResolvedValue({ taskId: 79 });
    const file = new File(["abcd"], "clip.mp4", { type: "video/mp4" });
    await expect(createVideoFromMultipart(env, userId, { file, title: "clip", description: "" }))
      .resolves.toMatchObject({ ok: true, video: { id: 42 } });
    expect(videoRepository.confirmUploadedVideo).toHaveBeenCalledExactlyOnceWith(
      env, 42, userId, media.putMediaObject.mock.calls[0][1],
    );
    expect(externalTasks.processExternalTaskById).toHaveBeenCalledExactlyOnceWith(env, 79);
  });
});
