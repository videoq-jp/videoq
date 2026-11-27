import { uploadConfirmed } from '../../domain/media/multipart-upload';
import type { CreationIdempotency } from "../../persistence/contracts/creation-idempotency";
import type { VideoUploadRepository } from "../../persistence/contracts/video-upload-repository";
import type { VideoMutationRepository } from "../../persistence/contracts/video-mutation-repository";
import type { VideoReadRepository, VideoDetail } from "../../persistence/contracts/video-read-repository";
import type { MultipartUploadRepository } from "../../persistence/contracts/multipart-upload-repository";
import {
  buildPendingUploadFileKey, fileExtension,
  parseReservedBytesFromFileKey,
} from "../../domain/media/upload";
import { videoTitleFailure, uploadFilenameFailure, uploadContentTypeFailure, uploadSizeFailure, transcriptionLanguageFailure } from "@videoq/domain/video-upload";

/** Only the capabilities needed by the upload lifecycle; no runtime environment. */
export interface VideoUploadDependencies<Body = unknown> {
  newFileKey(userId: string, bytes: number, extension: string): string;
  videos: Pick<VideoUploadRepository, "reserveUpload" | "getUploadState" | "confirmUpload">
    & Pick<VideoMutationRepository, "delete"> & Pick<VideoReadRepository, "getDetail">;
  storage: {
    presigned: boolean;
    signPut(fileKey: string, contentType: string, bytes: number): Promise<string>;
    size(fileKey: string): Promise<number | null>;
    put(fileKey: string, body: Body, contentType: string): Promise<void>;
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

export type DirectUploadFile<Body = unknown> = {
  name: string; type: string; size: number; stream(): Body;
};
export type DirectUploadInput<Body = unknown> = {
  file: DirectUploadFile<Body>; title: string; description: string; transcriptionLanguage?: string;
};
export type DirectUploadResult =
  | { ok: true; video: VideoDetail | null }
  | { ok: false; error: { kind: 'validation' | 'unavailable' | 'storage' | 'finalization' | 'quota'; code: string; message: string; details?: Record<string, string[]> } };

const uploadFailure = (kind: Extract<DirectUploadResult, { ok: false }>['error']['kind'],
  message: string, code = 'VALIDATION_ERROR', details?: Record<string, string[]>): Extract<DirectUploadResult, { ok: false }> =>
  ({ ok: false, error: { kind, code, message, ...(details ? { details } : {}) } });

/** Shared title validation preserves form error precedence without HTTP dependencies. */
export function directUploadTitleFailure(rawTitle: string) {
  const message = videoTitleFailure(rawTitle);
  return message ? uploadFailure('validation', message, 'VALIDATION_ERROR', { title: [message] }) : null;
}


export function createVideoUploadService<Body>(deps: VideoUploadDependencies<Body>) {
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
    const failures = {
      file_size: uploadSizeFailure(body.file_size, !body.multipart),
      filename: uploadFilenameFailure(body.filename),
      content_type: uploadContentTypeFailure(body.content_type),
      title: videoTitleFailure(body.title),
      transcriptionLanguage: transcriptionLanguageFailure(body.transcriptionLanguage),
    };
    for (const [field, error] of Object.entries(failures)) if (error) fieldError[field] = [error];
    if (Object.keys(fieldError).length) return { fieldError } as const;
    body = { ...body, title: body.title.trim(), filename: body.filename.trim(), content_type: body.content_type.trim() };
    const ext = fileExtension(body.filename);

    const fileKey = idempotency
      ? buildPendingUploadFileKey(
          userId,
          body.file_size,
          ext,
          Number.parseInt(idempotency.requestHash.slice(0, 12), 16),
          idempotency.requestHash.slice(12, 24),
        )
      : deps.newFileKey(userId, body.file_size, ext);
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
      if (!upload.fileKey || !uploadConfirmed(upload.status)) {
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
        if (!latest.fileKey || !uploadConfirmed(latest.status)) {
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

  async function createDirectUpload(userId: string, input: DirectUploadInput<Body>): Promise<DirectUploadResult> {
    if (storage.presigned) return uploadFailure('unavailable', 'Direct upload is unavailable in object-storage mode.');
    const { file, description, transcriptionLanguage } = input;
    const title = input.title.trim();
    const titleFailure = directUploadTitleFailure(title);
    if (titleFailure) return titleFailure;
    if (transcriptionLanguageFailure(transcriptionLanguage)) {
      return uploadFailure('validation', 'Invalid transcription language.', 'VALIDATION_ERROR', { transcriptionLanguage: ['Invalid transcription language.'] });
    }

    const filename = (file.name || '').trim();
    const contentType = (file.type || 'application/octet-stream').trim();
    const metadataFailure = uploadFilenameFailure(filename) ?? uploadContentTypeFailure(contentType) ?? uploadSizeFailure(file.size);
    if (metadataFailure) return uploadFailure('validation', metadataFailure, 'VALIDATION_ERROR', { file: [metadataFailure] });
    const ext = fileExtension(filename);
    const fileSize = file.size;
    const fileKey = deps.newFileKey(userId, fileSize, ext);
    const pending = await videos.reserveUpload({ userId, storageBytes: fileSize, fileKey, title, description, transcriptionLanguage });
    if ('monthlyUploadExceeded' in pending) return uploadFailure('quota', 'Monthly upload allowance exceeded.', 'MONTHLY_UPLOAD_LIMIT_EXCEEDED');
    if ('idempotencyConflict' in pending) throw new Error('Unexpected idempotency conflict without an idempotency key.');
    if ('overQuota' in pending) return uploadFailure('quota', 'Storage limit exceeded: account is over quota.', 'STORAGE_LIMIT_EXCEEDED');
    if ('exceeded' in pending) return uploadFailure('quota', `Storage limit exceeded. Limit: ${pending.limit} bytes.`, 'STORAGE_LIMIT_EXCEEDED');

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
      return uploadFailure('storage', 'Failed to store uploaded file.');
    }

    let transitioned: false | { taskId: number };
    try {
      transitioned = await videos.confirmUpload({ videoId: pending.videoId, userId, fileKey });
    } catch {
      return uploadFailure('finalization', 'Failed to finalize uploaded video.');
    }
    if (transitioned) await tasks.dispatch(transitioned.taskId);

    const video = await videos.getDetail(pending.videoId, userId);
    return { ok: true, video };
  }

  return { requestPresignedUpload, finishMultipartVideoUpload, abortVideoUpload, confirmVideoUpload, createDirectUpload };
}
