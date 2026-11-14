import { videoSourceTypeSchema, videoStatusSchema, type VideoSourceType, type VideoStatus } from "@videoq/trpc";
import { visualProcessingSchema, videoTagSchema } from "@videoq/trpc/schema";
import { toUtcIso } from "../shared/datetime";
import { resolveFileUrl } from "../integrations/media";
import type { Bindings } from "../types/bindings";
import type { VideoListItem, VideoDetail, VideoDetailRow } from "../persistence/contracts/video-read-repository";

function videoStatus(value: unknown): VideoStatus {
  return videoStatusSchema.parse(value);
}

function videoSourceType(value: unknown): VideoSourceType {
  return videoSourceTypeSchema.parse(value);
}

export async function mapVideoListRow(
  env: Bindings,
  r: Record<string, unknown>,
  options: { includeFileUrl?: boolean } = {},
): Promise<VideoListItem> {
  const youtubeId = (r.youtube_video_id as string) || null;
  return {
    id: Number(r.id),
    file:
      options.includeFileUrl === false
        ? null
        : await resolveFileUrl(env, (r.file as string) || null),
    title: r.title as string,
    description: r.description as string,
    uploaded_at: toUtcIso(r.uploaded_at as string),
    status: videoStatus(r.status),
    ...(r.visual_processing !== undefined ? { visual_processing: r.visual_processing ? visualProcessingSchema.parse(r.visual_processing) : null } : {}),
    source_type: videoSourceType(r.source_type),
    source_url: (r.source_url as string) || null,
    youtube_video_id: youtubeId,
    youtube_embed_url: youtubeId
      ? `https://www.youtube.com/embed/${youtubeId}`
      : null,
    tags: videoTagSchema.array().parse(JSON.parse(r.tags as string)),
  };
}

export async function mapVideoDetailRow(
  env: Bindings,
  row: VideoDetailRow,
  options: { includeFileUrl?: boolean } = {},
): Promise<VideoDetail> {
  return {
    ...await mapVideoListRow(env, row, options),
    user: String(row.user_id),
    transcript: row.transcript || null,
    error_message: row.error_message || null,
  };
}