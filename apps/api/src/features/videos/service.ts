import { requireFeature } from "../../lib/deployment";
import {
  listVideosPage,
  getVideoDetail,
  mapVideoDetailRow,
  updateVideo,
  getVideoFileKey,
  deleteVideoCascade,
  getVideoUploadState,
  confirmUploadedVideo,
  reserveAndCreatePendingVideo,
  createYoutubeVideo,
} from "../../repositories/video-repository";
import { validateTranscriptSrt } from "../../lib/srt";
import {
  getR2ObjectSize,
  isS3Storage,
  putMediaObject,
  presignR2Put,
} from "../../integrations/media";
import { videoOwnedBy } from "../../repositories/membership-repository";
import { resolveStorageBytesForRelease } from "../../lib/upload-reconcile";
import {
  buildPendingUploadFileKey,
  fileExtension,
  isAllowedExtension,
  isAllowedContentType,
  parseReservedBytesFromFileKey,
  unsupportedTypeMessage,
  invalidContentTypeMessage,
} from "../../lib/upload";
import {
  extractYoutubeVideoId,
  INVALID_YOUTUBE_URL_MESSAGE,
} from "../../lib/youtube";
import type { Bindings } from "../../types/bindings";
import { processExternalTaskById } from "../../lib/external-tasks";
import { armMaintenance } from "../../lib/task-scheduler";
import { ABANDONED_UPLOAD_MS } from "../../lib/upload-reconcile";
import type { CreationIdempotency } from "../../repositories/mcp-idempotency-repository";
import { MAX_SINGLE_UPLOAD_BYTES, MAX_VIDEO_UPLOAD_BYTES, TRANSCRIPTION_LANGUAGES } from "@videoq/trpc/video-upload";
import { initializeMultipartUpload, completeMultipartVideoUpload } from "../../repositories/multipart-upload-repository";

export { getMultipartUploadPartUrl, UploadSessionError } from "../../repositories/multipart-upload-repository";

export {
  countVideosByStatus as getUserVideoStats,
  getVideoDetail as getUserVideo,
} from "../../repositories/video-repository";

type UploadRequest = {
  multipart?: boolean;
  transcriptionLanguage?: string;
  filename: string;
  content_type: string;
  file_size: number;
  title: string;
  description: string;
};

type YoutubeCreateRequest = {
  youtube_url: string;
  title: string;
  description: string;
};

const CONFIRMED_UPLOAD_STATUSES = new Set(["pending", "processing", "indexing", "completed", "error"]);

const reportBestEffortFailure = (operation: string, error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "best_effort_failed",
      operation,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
};

async function dispatchCleanupTask(
  env: Bindings,
  taskId: number | null,
): Promise<void> {
  if (taskId !== null) await processExternalTaskById(env, taskId);
}

export type MultipartVideoResult =
  | { ok: true; video: Awaited<ReturnType<typeof getVideoDetail>> }
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

export async function listUserVideos(
  env: Bindings,
  userId: string,
  query: {
    q?: string;
    status?: string;
    ordering?: string;
    tags?: number[];
  },
  limit: number,
  offset: number,
) {
  return listVideosPage(
    env,
    userId,
    {
      keyword: query.q?.trim() ?? "",
      statusFilter: query.status?.trim() ?? "",
      sortKey: query.ordering?.trim() ?? "",
      tagIds: query.tags ?? null,
    },
    limit,
    offset,
  );
}

export async function requestPresignedUpload(
  env: Bindings,
  userId: string,
  body: UploadRequest,
  idempotency?: CreationIdempotency,
) {
  if (!isS3Storage(env)) {
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
  const pending = await reserveAndCreatePendingVideo(
    env,
    userId,
    body.file_size,
    fileKey,
    body.title,
    body.description,
    idempotency,
    body.transcriptionLanguage,
  );
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
  await armMaintenance(env, Date.now() + ABANDONED_UPLOAD_MS);

  const videoId = pending.videoId;
  try {
    const video = await getVideoDetail(env, videoId, userId);
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
      const multipart = await initializeMultipartUpload(env, videoId, userId, body.content_type);
      return { video, upload_url: null, multipart, reused: pending.reused, already_confirmed: false } as const;
    }
    const uploadUrl = await presignR2Put(
      env,
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
      const deleted = await deleteVideoCascade(env, videoId, userId, {
        expectedStatus: "uploading",
        expectedFileKey: pending.fileKey,
        fallbackStorageBytes: body.file_size,
      });
      await dispatchCleanupTask(env, deleted.cleanupTaskId);
    } catch (cleanupError) {
      reportBestEffortFailure("presigned_upload_cleanup", cleanupError);
    }
    throw error;
  }
}

export async function finishMultipartVideoUpload(
  env: Bindings, videoId: number, userId: string, parts: { partNumber: number; etag: string }[],
) {
  const taskId = await completeMultipartVideoUpload(env, videoId, userId, parts);
  if (taskId !== null) await processExternalTaskById(env, taskId);
  return getVideoDetail(env, videoId, userId);
}

export async function abortVideoUpload(env: Bindings, videoId: number, userId: string) {
  const deleted = await deleteVideoCascade(env, videoId, userId, { expectedStatus: "uploading" });
  await dispatchCleanupTask(env, deleted.cleanupTaskId);
  return { success: true };
}

export async function createUserYoutubeVideo(
  env: Bindings,
  userId: string,
  body: YoutubeCreateRequest,
  idempotency?: CreationIdempotency,
) {
  requireFeature(env, "youtube");
  const youtubeVideoId = extractYoutubeVideoId(body.youtube_url);
  if (youtubeVideoId === null) {
    return {
      fieldError: { youtube_url: [INVALID_YOUTUBE_URL_MESSAGE] },
    } as const;
  }

  const created = await createYoutubeVideo(
    env,
    userId,
    {
      sourceUrl: body.youtube_url,
      youtubeVideoId,
      title: body.title,
      description: body.description,
    },
    idempotency,
  );
  if ("idempotencyConflict" in created) return created;
  if (created.taskId !== null) {
    await processExternalTaskById(env, created.taskId);
  }
  return {
    video: await getVideoDetail(env, created.videoId, userId),
    reused: created.reused,
  } as const;
}

export async function confirmVideoUpload(
  env: Bindings,
  videoId: number,
  userId: string,
) {
  const upload = await getVideoUploadState(env, videoId, userId);
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
    const actualBytes = await getR2ObjectSize(env, upload.fileKey);
    if (actualBytes === null) {
      return {
        badState: true as const,
        message: "Uploaded object was not found.",
      };
    }
    if (reservedBytes !== null && actualBytes !== reservedBytes) {
      const deleted = await deleteVideoCascade(env, videoId, userId, {
        expectedStatus: "uploading",
        expectedFileKey: upload.fileKey,
        fallbackStorageBytes: reservedBytes,
      });
      await dispatchCleanupTask(env, deleted.cleanupTaskId);
      return {
        badState: true as const,
        message: "Uploaded object size does not match the reserved size.",
      };
    }
    const transitioned = await confirmUploadedVideo(env, videoId, userId, upload.fileKey);
    if (transitioned) {
      await processExternalTaskById(env, transitioned.taskId);
    } else {
      // A concurrent confirmation may have won after the initial status read.
      const latest = await getVideoUploadState(env, videoId, userId);
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
  const video = await getVideoDetail(env, videoId, userId);
  return video ? { video, alreadyConfirmed } as const : { notFound: true } as const;
}

export async function patchUserVideo(
  env: Bindings,
  videoId: number,
  userId: string,
  fields: { title?: string; description?: string; transcript?: string },
) {
  if (fields.transcript !== undefined) {
    const srtErr = validateTranscriptSrt(fields.transcript);
    if (srtErr) {
      if (!(await videoOwnedBy(env, videoId, userId))) return { notFound: true } as const;
      return { fieldError: { transcript: [srtErr] } } as const;
    }
  }

  const res = await updateVideo(env, videoId, userId, fields);
  if ("notFound" in res) return { notFound: true } as const;

  if (res.reindexTaskId !== null) {
    await processExternalTaskById(env, res.reindexTaskId);
  }
  return { video: await mapVideoDetailRow(env, res.row) } as const;
}

export async function deleteUserVideo(
  env: Bindings,
  videoId: number,
  userId: string,
) {
  const info = await getVideoFileKey(env, videoId, userId);
  if (!info.found) return { notFound: true } as const;

  const fileSize = await resolveStorageBytesForRelease(env, info.fileKey);

  const deleted = await deleteVideoCascade(env, videoId, userId, {
    fallbackStorageBytes: fileSize,
  });
  if (!deleted.deleted) return { notFound: true } as const;

  await dispatchCleanupTask(env, deleted.cleanupTaskId);

  return { ok: true } as const;
}

/** ローカル VIDEO_BUCKET 向け multipart upload（USE_S3_STORAGE=false のみ）。 */
export async function createVideoFromMultipart(
  env: Bindings,
  userId: string,
  form: Record<string, string | File>,
): Promise<MultipartVideoResult> {
  if (isS3Storage(env)) {
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
  const pending = await reserveAndCreatePendingVideo(
    env,
    userId,
    fileSize,
    fileKey,
    title,
    description,
    undefined,
    transcriptionLanguage,
  );
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
  await armMaintenance(env, Date.now() + ABANDONED_UPLOAD_MS);

  try {
    await putMediaObject(env, fileKey, file.stream(), contentType);
  } catch {
    try {
      const deleted = await deleteVideoCascade(env, pending.videoId, userId, {
        expectedStatus: "uploading",
        expectedFileKey: fileKey,
        fallbackStorageBytes: fileSize,
      });
      await dispatchCleanupTask(env, deleted.cleanupTaskId);
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
    transitioned = await confirmUploadedVideo(
      env,
      pending.videoId,
      userId,
      fileKey,
    );
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
  if (transitioned) await processExternalTaskById(env, transitioned.taskId);

  const video = await getVideoDetail(env, pending.videoId, userId);
  return { ok: true, video };
}
