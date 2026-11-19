import type { CreationIdempotency } from "../../persistence/contracts/creation-idempotency";
import type { VideoUploadRepository } from "../../persistence/contracts/video-upload-repository";
import type { VideoMutationRepository } from "../../persistence/contracts/video-mutation-repository";
import type { VideoReadRepository, VideoDetail } from "../../persistence/contracts/video-read-repository";
import type { MultipartUploadRepository } from "../../persistence/contracts/multipart-upload-repository";
import {
  buildPendingUploadFileKey, fileExtension, isAllowedExtension, isAllowedContentType,
  parseReservedBytesFromFileKey, unsupportedTypeMessage, invalidContentTypeMessage,
} from "../../lib/upload";
import { MAX_SINGLE_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES, TRANSCRIPTION_LANGUAGES } from "@videoq/trpc/video-upload";

/** Only the capabilities needed by the upload lifecycle; no runtime environment. */
export interface VideoUploadDependencies {
  videos: Pick<VideoUploadRepository, "reserveUpload" | "getUploadState" | "confirmUpload">
    & Pick<VideoMutationRepository, "delete"> & Pick<VideoReadRepository, "getDetail">;
  storage: {
    presigned: boolean;
    signPut(fileKey: string, contentType: string, bytes: number): Promise<string>;
    size(fileKey: string): Promise<number | null>;
    put(fileKey: string, body: ReadableStream, contentType: string): Promise<void>;
  };
  multipart: Pick<MultipartUploadRepository, "initialize" | "complete">;
  tasks: { dispatch(taskId: number): Promise<unknown>; scheduleRecovery(): Promise<void> };
  reportCleanupFailure(): void;
}

export type UploadRequest = {
  multipart?: boolean;
  transcriptionLanguage?: string;
  filename: string;
  content_type: string;
  file_size: number;
  title: string;
  description: string;
};

export type MultipartVideoResult =
  | { ok: true; video: VideoDetail | null }
  | { ok: false; status: number; body: unknown };

export function multipartUnavailableBody() {
  return {
    error: {
      code: "VALIDATION_ERROR",
      message:
        "Direct multipart upload is unavailable in object-storage mode. Call the videos.requestUpload tRPC procedure, PUT the file to upload_url, then call videos.confirmUpload.",
    },
  } as const;
}

const CONFIRMED_UPLOAD_STATUSES = new Set(["pending", "processing", "indexing", "completed", "error"]);

export function createVideoUploadService(deps: VideoUploadDependencies) {
  const { videos, storage, multipart, tasks } = deps;
  const dispatchCleanupTask = async (taskId: number | null): Promise<void> => {
    if (taskId !== null) await tasks.dispatch(taskId);
  };
  async function requestPresignedUpload(
    userId: string,
    body: UploadRequest,
    idempotency?: CreationIdempotency,
  ) {
    if (!storage.presigned) {
      return {
        badRequest:
          "Presigned upload URLs are unavailable when USE_S3_STORAGE=False.",
      } as const;
    }

    const fieldError: Record<string, string[]> = {};
    if (!Number.isSafeInteger(body.file_size) || body.file_size <= 0 || body.file_size > MAX_VIDEO_UPLOAD_BYTES) {
      fieldError.file_size = ["Invalid file size (exceeds the storage provider object limit)."];
    } else if (!body.multipart && body.file_size > MAX_SINGLE_UPLOAD_BYTES) {
      fieldError.file_size = ["Files larger than 5 GiB require multipart upload."];
    }
    const ext = fileExtension(body.filename);
    if (!isAllowedExtension(ext)) {
      fieldError.filename = [unsupportedTypeMessage(ext)];
    }
    if (!isAllowedContentType(body.content_type)) {
      fieldError.content_type = [invalidContentTypeMessage(body.content_type)];
    }
    if (Object.keys(fieldError).length) return { fieldError } as const;

    const fileKey = idempotency
      ? buildPendingUploadFileKey(
          userId,
          body.file_size,
          ext,
          Number.parseInt(idempotency.requestHash.slice(0, 12), 16),
          idempotency.requestHash.slice(12, 24),
        )
      : buildPendingUploadFileKey(userId, body.file_size, ext);
    const pending = await videos.reserveUpload({
      userId, storageBytes: body.file_size, fileKey, title: body.title,
      description: body.description, idempotency, transcriptionLanguage: body.transcriptionLanguage,
    });
    if ("monthlyUploadExceeded" in pending) {
      return { badRequest: "Monthly upload allowance exceeded.", code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED" } as const;
    }
    if ("idempotencyConflict" in pending) {
      return { idempotencyConflict: true } as const;
    }
    if ("overQuota" in pending) {
      return {
        badRequest: "Storage limit exceeded: account is over quota.",
        code: "STORAGE_LIMIT_EXCEEDED",
      } as const;
    }
    if ("exceeded" in pending) {
      return {
        badRequest: `Storage limit exceeded. Limit: ${pending.limit} bytes.`,
        code: "STORAGE_LIMIT_EXCEEDED",
      } as const;
    }

    // 署名 URL を渡した先でアップロードが放棄されうる。予約したストレージを
    // 返すのは回復処理なので、その起床時刻をここで予約しておく。
    await tasks.scheduleRecovery();

    const videoId = pending.videoId;
    try {
      const video = await videos.getDetail(videoId, userId);
      if (!video) {
        throw new Error("Reserved video could not be loaded.");
      }
      // Once confirmation has advanced the state, never mint another PUT URL for
      // the same object. A late retry must not be able to overwrite media that is
      // already being processed (or has completed processing).
      if (pending.reused && video.status !== "uploading") {
        return {
          video,
          upload_url: null,
          reused: true,
          already_confirmed: true,
        } as const;
      }
      if (body.multipart) {
        const session = await multipart.initialize(videoId, userId, body.content_type);
        return { video, upload_url: null, multipart: session, reused: pending.reused, already_confirmed: false } as const;
      }
      const uploadUrl = await storage.signPut(
        pending.fileKey,
        body.content_type,
        body.file_size,
      );
      return {
        video,
        upload_url: uploadUrl,
        reused: pending.reused,
        already_confirmed: false,
      } as const;
    } catch (error) {
      if (pending.reused) throw error;
      try {
        const deleted = await videos.delete(videoId, userId, {
          expectedStatus: "uploading",
          expectedFileKey: pending.fileKey,
          fallbackStorageBytes: body.file_size,
        });
        await dispatchCleanupTask(deleted.cleanupTaskId);
      } catch {
        deps.reportCleanupFailure();
      }
      throw error;
    }
  }

  async function finishMultipartVideoUpload(
    videoId: number, userId: string, parts: { partNumber: number; etag: string }[],
  ) {
    const taskId = await multipart.complete(videoId, userId, parts);
    if (taskId !== null) await tasks.dispatch(taskId);
    return videos.getDetail(videoId, userId);
  }

  async function abortVideoUpload(videoId: number, userId: string) {
    const deleted = await videos.delete(videoId, userId, { expectedStatus: "uploading" });
    await dispatchCleanupTask(deleted.cleanupTaskId);
    return { success: true };
  }

  async function confirmVideoUpload(
    videoId: number,
    userId: string,
  ) {
    const upload = await videos.getUploadState(videoId, userId);
    if (!upload.found) return { notFound: true } as const;
    let alreadyConfirmed = upload.status !== "uploading";
    if (alreadyConfirmed) {
      if (!upload.fileKey || !CONFIRMED_UPLOAD_STATUSES.has(upload.status)) {
        return {
          badState: true as const,
          message: `Video is in '${upload.status}' state, expected 'uploading'`,
        };
      }
    } else {
      if (!upload.fileKey) return { notFound: true } as const;
      const reservedBytes = parseReservedBytesFromFileKey(upload.fileKey);
      const actualBytes = await storage.size(upload.fileKey);
      if (actualBytes === null) {
        return {
          badState: true as const,
          message: "Uploaded object was not found.",
        };
      }
      if (reservedBytes !== null && actualBytes !== reservedBytes) {
        const deleted = await videos.delete(videoId, userId, {
          expectedStatus: "uploading",
          expectedFileKey: upload.fileKey,
          fallbackStorageBytes: reservedBytes,
        });
        await dispatchCleanupTask(deleted.cleanupTaskId);
        return {
          badState: true as const,
          message: "Uploaded object size does not match the reserved size.",
        };
      }
      const transitioned = await videos.confirmUpload({ videoId, userId, fileKey: upload.fileKey });
      if (transitioned) {
        await tasks.dispatch(transitioned.taskId);
      } else {
        // A concurrent confirmation may have won after the initial status read.
        const latest = await videos.getUploadState(videoId, userId);
        if (!latest.found) return { notFound: true } as const;
        if (!latest.fileKey || !CONFIRMED_UPLOAD_STATUSES.has(latest.status)) {
          return {
            badState: true as const,
            message: "Video upload changed before confirmation.",
          };
        }
        alreadyConfirmed = true;
      }
    }
    const video = await videos.getDetail(videoId, userId);
    return video ? { video, alreadyConfirmed } as const : { notFound: true } as const;
  }

  async function createVideoFromMultipart(
    userId: string,
    form: Record<string, string | File>,
  ): Promise<MultipartVideoResult> {
    if (storage.presigned) {
      return {
        ok: false,
        status: 400,
        body: multipartUnavailableBody(),
      };
    }

    const file = form.file;
    if (!(file instanceof File)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "No file was submitted.",
            details: { file: ["No file was submitted."] },
          },
        },
      };
    }

    const titleRaw = typeof form.title === "string" ? form.title.trim() : "";
    if (!titleRaw) {
      const msg =
        form.title === undefined || form.title === ""
          ? form.title === ""
            ? "This field may not be blank."
            : "This field is required."
          : "Not a valid string.";
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: msg,
            details: { title: [msg] },
          },
        },
      };
    }
    if ([...titleRaw].length > 255) {
      const msg = "Ensure this field has no more than 255 characters.";
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: msg,
            details: { title: [msg] },
          },
        },
      };
    }
    const description =
      typeof form.description === "string" ? form.description : "";
    const transcriptionLanguage = form.transcriptionLanguage;
    if (transcriptionLanguage !== undefined && (typeof transcriptionLanguage !== 'string' || !Object.hasOwn(TRANSCRIPTION_LANGUAGES, transcriptionLanguage))) {
      return { ok: false, status: 400, body: { error: {
        code: 'VALIDATION_ERROR', message: 'Invalid transcription language.',
        details: { transcriptionLanguage: ['Invalid transcription language.'] },
      } } };
    }
    const title = titleRaw;

    const ext = fileExtension(file.name || "");
    if (!isAllowedExtension(ext)) {
      const msg = unsupportedTypeMessage(ext);
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: msg,
            details: { file: [msg] },
          },
        },
      };
    }
    const contentType = file.type || "application/octet-stream";
    if (!isAllowedContentType(contentType)) {
      const msg = invalidContentTypeMessage(contentType);
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: msg,
            details: { file: [msg] },
          },
        },
      };
    }

    const fileSize = file.size;
    const fileKey = buildPendingUploadFileKey(userId, fileSize, ext);
    const pending = await videos.reserveUpload({ userId, storageBytes: fileSize, fileKey, title, description, transcriptionLanguage });
    if ("monthlyUploadExceeded" in pending) {
      return { ok: false, status: 400, body: { error: {
        code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED", message: "Monthly upload allowance exceeded.",
      } } };
    }
    if ("idempotencyConflict" in pending) {
      throw new Error("Unexpected idempotency conflict without an idempotency key.");
    }
    if ("overQuota" in pending) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "STORAGE_LIMIT_EXCEEDED",
            message: "Storage limit exceeded: account is over quota.",
          },
        },
      };
    }
    if ("exceeded" in pending) {
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            code: "STORAGE_LIMIT_EXCEEDED",
            message: `Storage limit exceeded. Limit: ${pending.limit} bytes.`,
          },
        },
      };
    }

    // 転送中に Worker が落ちれば uploading の行だけが残る。回収時刻を先に予約する。
    await tasks.scheduleRecovery();

    try {
      await storage.put(fileKey, file.stream(), contentType);
    } catch {
      try {
        const deleted = await videos.delete(pending.videoId, userId, {
          expectedStatus: "uploading",
          expectedFileKey: fileKey,
          fallbackStorageBytes: fileSize,
        });
        await dispatchCleanupTask(deleted.cleanupTaskId);
      } catch {
        /* cleanup task is persisted atomically with the video deletion */
      }
      return {
        ok: false,
        status: 500,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Failed to store uploaded file.",
          },
        },
      };
    }

    let transitioned: false | { taskId: number };
    try {
      transitioned = await videos.confirmUpload({ videoId: pending.videoId, userId, fileKey });
    } catch {
      return {
        ok: false,
        status: 500,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Failed to finalize uploaded video.",
          },
        },
      };
    }
    if (transitioned) await tasks.dispatch(transitioned.taskId);

    const video = await videos.getDetail(pending.videoId, userId);
    return { ok: true, video };
  }

  return { requestPresignedUpload, finishMultipartVideoUpload, abortVideoUpload, confirmVideoUpload, createVideoFromMultipart };
}
