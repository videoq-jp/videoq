import type { VideoUploadRequest, apiClient } from './api';
import type { appTrpcClient } from './trpc';
import { videoUploadContentType, type TranscriptionLanguage } from '@videoq/trpc/video-upload';

interface UploadApi {
  uploadVideo: typeof apiClient.uploadVideo;
  createYoutubeVideo: typeof appTrpcClient.videos.createYoutube.mutate;
  addTagsToVideo: typeof appTrpcClient.memberships.addTags.mutate;
}

type UploadDraft = { title: string; description: string } & (
  | { source: 'file'; file: File | null; maxSizeMb: number; transcriptionLanguage?: TranscriptionLanguage }
  | { source: 'youtube'; youtubeUrl: string }
);

export type UploadSourceMode = UploadDraft['source'];
export type PreparedUpload =
  | { source: 'file'; data: VideoUploadRequest }
  | { source: 'youtube'; data: Parameters<UploadApi['createYoutubeVideo']>[0] };

type UploadPreparation =
  | { isValid: true; upload: PreparedUpload }
  | { isValid: false; error: string; errorParams?: Record<string, unknown> };

/** Validate the draft once, returning the exact input accepted by its transport. */
export function prepareVideoUpload(input: UploadDraft): UploadPreparation {
  const description = input.description.trim() || undefined;
  if (input.source === 'file') {
    const { file, maxSizeMb } = input;
    if (!file) return { isValid: false, error: 'videos.upload.validation.noFile' };
    if (!videoUploadContentType(file)) {
      return { isValid: false, error: 'videos.upload.validation.invalidFileType' };
    }
    if (file.size > maxSizeMb * 1024 * 1024) {
      return {
        isValid: false,
        error: 'videos.upload.validation.fileTooLarge',
        errorParams: { max_size_mb: maxSizeMb },
      };
    }
    const title = input.title.trim() || file.name.replace(/\.[^/.]+$/, '');
    return { isValid: true, upload: { source: 'file', data: { file, title, description, ...(input.transcriptionLanguage ? { transcriptionLanguage: input.transcriptionLanguage } : {}) } } };
  }

  const youtubeUrl = input.youtubeUrl.trim();
  if (!youtubeUrl) return { isValid: false, error: 'videos.upload.validation.noYoutubeUrl' };
  const title = input.title.trim();
  if (!title) return { isValid: false, error: 'videos.upload.validation.noTitle' };
  return { isValid: true, upload: { source: 'youtube', data: { youtubeUrl, title, description } } };
}

export async function runUploadWorkflow(
  upload: PreparedUpload,
  tagIds: number[],
  api: UploadApi,
  onProgress?: (percent: number) => void,
): Promise<'videos.upload.warning.tagsFailed' | null> {
  const video = upload.source === 'file'
    ? await api.uploadVideo(upload.data, onProgress)
    : await api.createYoutubeVideo(upload.data);
  if (tagIds.length > 0) {
    try {
      await api.addTagsToVideo({ videoId: video.id, tagIds });
    } catch {
      return 'videos.upload.warning.tagsFailed';
    }
  }
  return null;
}
