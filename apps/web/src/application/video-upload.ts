import { MAX_VIDEO_UPLOAD_BYTES, videoUploadContentType, type TranscriptionLanguage } from '@videoq/domain/video-upload';

export type UploadQuotaSnapshot = {
  storageLimitBytes?: number | null; storageUsedBytes?: number | null;
  monthlyLimitBytes?: number | null; monthlyUsedBytes?: number | null; uploadResetsAt?: string | null;
};

/** Cached monthly usage expires at submit time, including a form kept open
 * across the reset. Storage denial retains precedence over monthly denial. */
export function uploadCompressionBudget(quota: UploadQuotaSnapshot, nowMs: number) {
  const storageRemaining = quota.storageLimitBytes == null ? Infinity
    : Math.max(0, quota.storageLimitBytes - (quota.storageUsedBytes ?? 0));
  const uploadUsed = quota.uploadResetsAt && Date.parse(quota.uploadResetsAt) <= nowMs
    ? 0 : quota.monthlyUsedBytes ?? 0;
  const monthlyRemaining = quota.monthlyLimitBytes == null ? Infinity
    : Math.max(0, quota.monthlyLimitBytes - uploadUsed);
  const maxBytes = Math.min(MAX_VIDEO_UPLOAD_BYTES, storageRemaining, monthlyRemaining);
  const blockedBy = maxBytes <= 0 ? (storageRemaining <= 0 ? 'storage' : 'monthly') : null;
  return { maxBytes, blockedBy };
}

export function compressedUploadExceedsBudget(actualBytes: number, maxBytes: number): boolean {
  return actualBytes > maxBytes;
}

export interface UploadAsset { name: string; type: string; size: number; }
export type UploadFileData<F extends UploadAsset> = { file: F; title: string; description?: string; transcriptionLanguage?: TranscriptionLanguage };
export type YoutubeUploadData = { youtubeUrl: string; title: string; description?: string };
export interface UploadApi<F extends UploadAsset> {
  uploadVideo(data: UploadFileData<F>, onProgress?: (percent: number) => void): Promise<{ id: number }>;
  createYoutubeVideo(data: YoutubeUploadData): Promise<{ id: number }>;
  addTagsToVideo(input: { videoId: number; tagIds: number[] }): Promise<unknown>;
}

export type UploadDraft<F extends UploadAsset> = { title: string; description: string } & (
  | { source: 'file'; file: F | null; maxSizeMb: number; transcriptionLanguage?: TranscriptionLanguage }
  | { source: 'youtube'; youtubeUrl: string }
);

export type UploadSourceMode = 'file' | 'youtube';
export type PreparedUpload<F extends UploadAsset> =
  | { source: 'file'; data: UploadFileData<F> }
  | { source: 'youtube'; data: YoutubeUploadData };

export type UploadFailure = 'no_file' | 'invalid_file_type' | 'file_too_large' | 'no_youtube_url' | 'no_title';

type UploadPreparation<F extends UploadAsset> =
  | { isValid: true; upload: PreparedUpload<F> }
  | { isValid: false; error: UploadFailure; maxSizeMb?: number };

/** Validate the draft once, returning the exact input accepted by its transport. */
export function prepareVideoUpload<F extends UploadAsset>(input: UploadDraft<F>): UploadPreparation<F> {
  const description = input.description.trim() || undefined;
  if (input.source === 'file') {
    const { file, maxSizeMb } = input;
    if (!file) return { isValid: false, error: 'no_file' };
    if (!videoUploadContentType(file)) {
      return { isValid: false, error: 'invalid_file_type' };
    }
    if (file.size > maxSizeMb * 1024 * 1024) {
      return {
        isValid: false,
        error: 'file_too_large',
        maxSizeMb,
      };
    }
    const title = input.title.trim() || file.name.replace(/\.[^/.]+$/, '');
    return { isValid: true, upload: { source: 'file', data: { file, title, description, ...(input.transcriptionLanguage ? { transcriptionLanguage: input.transcriptionLanguage } : {}) } } };
  }

  const youtubeUrl = input.youtubeUrl.trim();
  if (!youtubeUrl) return { isValid: false, error: 'no_youtube_url' };
  const title = input.title.trim();
  if (!title) return { isValid: false, error: 'no_title' };
  return { isValid: true, upload: { source: 'youtube', data: { youtubeUrl, title, description } } };
}

export async function runUploadWorkflow<F extends UploadAsset>(
  upload: PreparedUpload<F>,
  tagIds: number[],
  api: UploadApi<F>,
  onProgress?: (percent: number) => void,
): Promise<'tags_failed' | null> {
  const video = upload.source === 'file'
    ? await api.uploadVideo(upload.data, onProgress)
    : await api.createYoutubeVideo(upload.data);
  if (tagIds.length > 0) {
    try {
      await api.addTagsToVideo({ videoId: video.id, tagIds });
    } catch {
      return 'tags_failed';
    }
  }
  return null;
}
