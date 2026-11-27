import { describe, expect, it, vi } from "vitest";
import { createVideoUploadService, type VideoUploadDependencies } from "../src/features/videos/upload-service";
import type { VideoDetail } from "../src/persistence/contracts/video-read-repository";

const fileKey = "videos/owner/video_123_abcdef012345_100.mp4";
const request = { filename: "lesson.mp4", content_type: "video/mp4", file_size: 100, title: "Lesson", description: "" };
const video: VideoDetail = {
  id: 7, user: "owner", file: fileKey, title: "Lesson", description: "", uploaded_at: "2026-01-01T00:00:00Z",
  status: "uploading", source_type: "uploaded", source_url: null, youtube_video_id: null,
  youtube_embed_url: null, tags: [], transcript: null, error_message: null,
};
function fixture() {
  const deps = {
    newFileKey: vi.fn<VideoUploadDependencies["newFileKey"]>().mockReturnValue(fileKey),
    videos: {
      reserveUpload: vi.fn<VideoUploadDependencies['videos']['reserveUpload']>().mockResolvedValue({ ok: true, videoId: 7, fileKey, reused: false }),
      getUploadState: vi.fn<VideoUploadDependencies['videos']['getUploadState']>().mockResolvedValue({ found: true, status: "uploading", fileKey }),
      confirmUpload: vi.fn<VideoUploadDependencies['videos']['confirmUpload']>().mockResolvedValue({ videoId: 7, taskId: 8, jobId: "job" }),
      delete: vi.fn<VideoUploadDependencies['videos']['delete']>().mockResolvedValue({ deleted: true, cleanupTaskId: 9 }),
      getDetail: vi.fn<VideoUploadDependencies['videos']['getDetail']>().mockResolvedValue(video),
    },
    storage: {
      presigned: true,
      signPut: vi.fn<VideoUploadDependencies['storage']['signPut']>().mockResolvedValue("https://storage.test/put"),
      size: vi.fn<VideoUploadDependencies['storage']['size']>().mockResolvedValue(100),
      put: vi.fn<VideoUploadDependencies['storage']['put']>().mockResolvedValue(),
    },
    multipart: {
      initialize: vi.fn<VideoUploadDependencies['multipart']['initialize']>().mockResolvedValue({ part_size: 100, part_count: 1 }),
      complete: vi.fn<VideoUploadDependencies['multipart']['complete']>().mockResolvedValue(8),
    },
    tasks: { dispatch: vi.fn<VideoUploadDependencies['tasks']['dispatch']>().mockResolvedValue(true), scheduleRecovery: vi.fn<VideoUploadDependencies['tasks']['scheduleRecovery']>().mockResolvedValue() },
    reportCleanupFailure: vi.fn(),
  } satisfies VideoUploadDependencies;
  return { deps, service: createVideoUploadService(deps) };
}

describe("upload lifecycle without a runtime environment", () => {
  it("rejects invalid input and quota failures before issuing storage access", async () => {
    const { deps, service } = fixture();
    expect(await service.requestPresignedUpload("owner", { ...request, file_size: -1 })).toHaveProperty("fieldError");
    expect(deps.videos.reserveUpload).not.toHaveBeenCalled();
    deps.videos.reserveUpload.mockResolvedValue({ monthlyUploadExceeded: true, limit: 100 });
    expect(await service.requestPresignedUpload("owner", request)).toMatchObject({ code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED" });
    expect(deps.storage.signPut).not.toHaveBeenCalled();
    expect(deps.tasks.scheduleRecovery).not.toHaveBeenCalled();
  });
  it("schedules recovery before exposing an upload URL", async () => {
    const { deps, service } = fixture();
    deps.storage.signPut.mockImplementation(() => {
      expect(deps.tasks.scheduleRecovery).toHaveBeenCalledOnce();
      return Promise.resolve("https://storage.test/put");
    });
    expect(await service.requestPresignedUpload("owner", request)).toMatchObject({ upload_url: "https://storage.test/put" });
    expect(deps.storage.signPut).toHaveBeenCalledWith(fileKey, "video/mp4", 100);
  });
  it("never issues another PUT or multipart session for a confirmed idempotent retry", async () => {
    const { deps, service } = fixture();
    deps.videos.reserveUpload.mockResolvedValue({ ok: true, videoId: 7, fileKey, reused: true });
    deps.videos.getDetail.mockResolvedValue({ ...video, status: "processing" });
    for (const multipart of [false, true]) {
      expect(await service.requestPresignedUpload("owner", { ...request, multipart })).toMatchObject({ already_confirmed: true, upload_url: null });
    }
    expect(deps.storage.signPut).not.toHaveBeenCalled();
    expect(deps.multipart.initialize).not.toHaveBeenCalled();
    expect(deps.videos.delete).not.toHaveBeenCalled();
  });
  it.each([false, true])("only rolls back a new reservation after signing fails (reused=%s)", async reused => {
    const { deps, service } = fixture();
    deps.videos.reserveUpload.mockResolvedValue({ ok: true, videoId: 7, fileKey, reused });
    const failure = new Error("Storage unavailable");
    deps.storage.signPut.mockRejectedValue(failure);
    await expect(service.requestPresignedUpload("owner", request)).rejects.toBe(failure);
    if (reused) expect(deps.videos.delete).not.toHaveBeenCalled();
    else {
      expect(deps.videos.delete).toHaveBeenCalledWith(7, "owner", { expectedStatus: "uploading", expectedFileKey: fileKey, fallbackStorageBytes: 100 });
      expect(deps.tasks.dispatch).toHaveBeenCalledWith(9);
    }
  });
  it("preserves the original failure when cleanup fails", async () => {
    const { deps, service } = fixture();
    const failure = new Error("Signing failed");
    deps.storage.signPut.mockRejectedValue(failure);
    deps.videos.delete.mockRejectedValue(new Error("Cleanup failed"));
    await expect(service.requestPresignedUpload("owner", request)).rejects.toBe(failure);
    expect(deps.reportCleanupFailure).toHaveBeenCalledOnce();
  });
  it("rejects mismatched media and conditionally deletes the reserved object", async () => {
    const { deps, service } = fixture();
    deps.storage.size.mockResolvedValue(99);
    expect(await service.confirmVideoUpload(7, "owner")).toMatchObject({ badState: true });
    expect(deps.videos.confirmUpload).not.toHaveBeenCalled();
    expect(deps.videos.delete).toHaveBeenCalledWith(7, "owner", { expectedStatus: "uploading", expectedFileKey: fileKey, fallbackStorageBytes: 100 });
    expect(deps.tasks.dispatch).toHaveBeenCalledWith(9);
  });
  it("does not delete or confirm when the media is missing", async () => {
    const { deps, service } = fixture();
    deps.storage.size.mockResolvedValue(null);
    expect(await service.confirmVideoUpload(7, "owner")).toMatchObject({ badState: true });
    expect(deps.videos.delete).not.toHaveBeenCalled();
    expect(deps.videos.confirmUpload).not.toHaveBeenCalled();
  });
  it("dispatches only after the atomic confirmation succeeds", async () => {
    const { deps, service } = fixture();
    deps.videos.getDetail.mockResolvedValue({ ...video, status: "pending" });
    expect(await service.confirmVideoUpload(7, "owner")).toMatchObject({ alreadyConfirmed: false, video: { status: "pending" } });
    expect(deps.videos.confirmUpload).toHaveBeenCalledWith({ videoId: 7, userId: "owner", fileKey });
    expect(deps.tasks.dispatch).toHaveBeenCalledWith(8);
    deps.videos.confirmUpload.mockRejectedValue(new Error("Database unavailable"));
    deps.tasks.dispatch.mockClear();
    await expect(service.confirmVideoUpload(7, "owner")).rejects.toThrow("Database unavailable");
    expect(deps.tasks.dispatch).not.toHaveBeenCalled();
  });
  it("accepts a concurrent confirmation without duplicate job dispatch", async () => {
    const { deps, service } = fixture();
    deps.videos.confirmUpload.mockResolvedValue(false);
    deps.videos.getUploadState.mockResolvedValueOnce({ found: true, status: "uploading", fileKey })
      .mockResolvedValueOnce({ found: true, status: "pending", fileKey });
    expect(await service.confirmVideoUpload(7, "owner")).toMatchObject({ alreadyConfirmed: true });
    expect(deps.tasks.dispatch).not.toHaveBeenCalled();
  });
  it("streams direct uploads and leaves confirmed state intact if an abort loses a race", async () => {
    const { deps, service } = fixture();
    deps.storage.presigned = false;
    const file = new File(["x"], "lesson.mp4", { type: "video/mp4" });
    expect(await service.createDirectUpload("owner", { file, title: "Lesson", description: "" })).toMatchObject({ ok: true });
    expect(deps.storage.put.mock.calls[0][1]).toBeInstanceOf(ReadableStream);
    expect(deps.tasks.dispatch).toHaveBeenCalledWith(8);
    deps.videos.delete.mockResolvedValue({ deleted: false, cleanupTaskId: null });
    deps.tasks.dispatch.mockClear();
    await service.abortVideoUpload(7, "owner");
    expect(deps.videos.delete).toHaveBeenCalledWith(7, "owner", { expectedStatus: "uploading" });
    expect(deps.tasks.dispatch).not.toHaveBeenCalled();
  });
});

describe('direct upload application failures', () => {
  const input = () => ({ file: { name: 'lesson.mp4', type: 'video/mp4', size: 1,
    stream: () => new ReadableStream() }, title: 'Lesson', description: '' });

  it('validates plain file metadata before reserving storage', async () => {
    const { deps, service } = fixture();
    deps.storage.presigned = false;
    const invalid = { ...input(), title: ' ' };
    expect(await service.createDirectUpload('owner', invalid)).toMatchObject({ ok: false, error: { kind: 'validation', details: { title: ['This field may not be blank.'] } } });
    expect(deps.videos.reserveUpload).not.toHaveBeenCalled();
  });

  it('returns storage failure after attempting atomic cleanup and never confirms', async () => {
    const { deps, service } = fixture();
    deps.storage.presigned = false;
    deps.storage.put.mockRejectedValue(new Error('Storage unavailable'));
    expect(await service.createDirectUpload('owner', input())).toEqual({ ok: false, error: { kind: 'storage', code: 'VALIDATION_ERROR', message: 'Failed to store uploaded file.' } });
    expect(deps.videos.delete).toHaveBeenCalledWith(7, 'owner', expect.objectContaining({ expectedStatus: 'uploading', fallbackStorageBytes: 1 }));
    expect(deps.tasks.dispatch).toHaveBeenCalledWith(9);
    expect(deps.videos.confirmUpload).not.toHaveBeenCalled();
  });

  it('leaves a stored upload recoverable when confirmation fails', async () => {
    const { deps, service } = fixture();
    deps.storage.presigned = false;
    deps.videos.confirmUpload.mockRejectedValue(new Error('Database unavailable'));
    expect(await service.createDirectUpload('owner', input())).toMatchObject({ ok: false, error: { kind: 'finalization' } });
    expect(deps.storage.put).toHaveBeenCalledOnce();
    expect(deps.tasks.scheduleRecovery).toHaveBeenCalledOnce();
    expect(deps.tasks.dispatch).not.toHaveBeenCalled();
    expect(deps.videos.delete).not.toHaveBeenCalled();
  });
});

it.each(['title','description','filename'] as const)('rejects NUL upload %s before reservation or storage', async field => {
  const {deps,service} = fixture();
  const bad = 'prefix' + String.fromCharCode(0) + '.mp4';
  expect(await service.requestPresignedUpload('owner',{...request,[field]:bad})).toHaveProperty(`fieldError.${field}`);
  deps.storage.presigned = false;
  expect(await service.createDirectUpload('owner',{
    file:{name:field === 'filename' ? bad : 'lesson.mp4',type:'video/mp4',size:3,stream:()=>new Uint8Array([1,2,3])},
    title:field === 'title' ? bad : 'Lesson',description:field === 'description' ? bad : '',
  })).toMatchObject({ok:false,error:{kind:'validation'}});
  expect(deps.videos.reserveUpload).not.toHaveBeenCalled();
  expect(deps.storage.put).not.toHaveBeenCalled();
});
