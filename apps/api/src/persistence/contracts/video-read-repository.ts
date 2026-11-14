import type { VideoSourceType, VideoStatus } from "@videoq/trpc";

export type VideoListItem = {
  id: number;
  file: string | null;
  title: string;
  description: string;
  uploaded_at: string;
  status: VideoStatus;
  visual_processing?: { status: "processing" | "ready" | "error"; completed_chunks: number; total_chunks: number } | null;
  source_type: VideoSourceType;
  source_url: string | null;
  youtube_video_id: string | null;
  youtube_embed_url: string | null;
  tags: { id: number; name: string; color: string }[];
};

export type VideoDetail = VideoListItem & {
  user: string;
  transcript: string | null;
  error_message: string | null;
};

export type VideoListCriteria = {
  keyword: string; // q
  statusFilter: string; // カンマ区切り
  sortKey: string; // ordering
  tagIds: number[] | null;
};

export type StaleUploadingVideo = {
  id: number;
  userId: string;
  fileKey: string | null;
};

export type VideoStatusCounts = {
  total: number;
  completed: number;
  pending: number;
  processing: number;
  indexing: number;
  error: number;
  uploading: number;
};

export type VideoDetailRow = {
 id: number; user_id: string; file: string; title: string; description: string; uploaded_at: string;
 transcript: string; status: string; source_type: string; source_url: string; youtube_video_id: string;
 error_message: string; tags: string; visual_processing?: unknown;
};
export type VideoMetadata = VideoListItem & {
 error_message: string | null; transcript_available: boolean; transcript_total_chars: number;
};
export interface VideoReadRepository {
 getDetail(videoId: number,userId: string,options?: {includeFileUrl?: boolean}): Promise<VideoDetail | null>;
 getMetadata(videoId: number,userId: string): Promise<VideoMetadata | null>;
 listStaleUploads(olderThanHours: number,limit?: number): Promise<StaleUploadingVideo[]>;
 countByStatus(userId: string): Promise<VideoStatusCounts>;
 listPage(userId: string,criteria: VideoListCriteria,limit: number,offset: number,options?: {includeFileUrls?: boolean}): Promise<{count: number;results: VideoListItem[]}>;
}
