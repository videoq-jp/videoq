import { videoTitleFailure } from '@videoq/domain/video-upload';
import type { CreationIdempotency } from "../../persistence/contracts/creation-idempotency";
import {
  INVALID_YOUTUBE_URL_MESSAGE,
} from "../../domain/media/youtube";
import type {
  VideoManagementDependencies,
  YoutubeCreateRequest,
} from "./management-ports";

export function createVideoManagementService(
  deps: VideoManagementDependencies,
) {
  async function dispatchCleanupTask(taskId: number | null): Promise<void> {
    if (taskId !== null) await deps.dispatch(taskId);
  }

  async function listUserVideos(
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
    return deps.list(
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

  async function createUserYoutubeVideo(
    userId: string,
    body: YoutubeCreateRequest,
    idempotency?: CreationIdempotency,
  ) {
    const titleError = videoTitleFailure(body.title);
    if (titleError) return { fieldError: { title: [titleError] } } as const;
    body = { ...body, title: body.title.trim() };
    deps.requireYoutube();
    const youtubeVideoId = deps.extractYoutubeVideoId(body.youtube_url);
    if (youtubeVideoId === null) {
      return {
        fieldError: { youtube_url: [INVALID_YOUTUBE_URL_MESSAGE] },
      } as const;
    }

    const created = await deps.createYoutube(
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
      await deps.dispatch(created.taskId);
    }
    return {
      video: await deps.detail(created.videoId, userId),
      reused: created.reused,
    } as const;
  }

  async function patchUserVideo(
    videoId: number,
    userId: string,
    fields: { title?: string; description?: string; transcript?: string },
  ) {
    if (fields.title !== undefined) {
      const error = videoTitleFailure(fields.title);
      if (error) {
        if (!await deps.ownedBy(videoId, userId)) return { notFound: true } as const;
        return { fieldError: { title: [error] } } as const;
      }
      fields = { ...fields, title: fields.title.trim() };
    }
    if (fields.transcript !== undefined) {
      const srtErr = deps.validateTranscript(fields.transcript);
      if (srtErr) {
        if (!(await deps.ownedBy(videoId, userId)))
          return { notFound: true } as const;
        return { fieldError: { transcript: [srtErr] } } as const;
      }
    }

    const res = await deps.update(videoId, userId, fields);
    if ("notFound" in res) return { notFound: true } as const;

    if (res.reindexTaskId !== null) {
      await deps.dispatch(res.reindexTaskId);
    }
    return { video: await deps.mapDetail(res.row) } as const;
  }

  async function deleteUserVideo(videoId: number, userId: string) {
    const info = await deps.fileKey(videoId, userId);
    if (!info.found) return { notFound: true } as const;

    const fileSize = await deps.storageBytes(info.fileKey);

    const deleted = await deps.delete(videoId, userId, {
      fallbackStorageBytes: fileSize,
    });
    if (!deleted.deleted) return { notFound: true } as const;

    await dispatchCleanupTask(deleted.cleanupTaskId);

    return { ok: true } as const;
  }

  return {
    listUserVideos,
    createUserYoutubeVideo,
    patchUserVideo,
    deleteUserVideo,
  };
}
