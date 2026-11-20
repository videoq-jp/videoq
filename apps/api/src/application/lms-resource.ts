import type { TranscriptionLanguage } from '@videoq/domain/video-upload';

export type LmsResource = {
  id: string; installationId: string; externalId: string; kind: string; contextId: string; resourceLinkId: string;
  generation: number; manifestHash: string; enabled: boolean; contentHash: string | null; contentType: string | null;
  fileSize: number | null; youtubeVideoId: string | null; courseId: number | null; videoId: number | null;
  syncError: string | null; updatedAt: string;
};

export type ResourceManifest = {
  generation: number; contextId: string; courseTitle?: string; resourceLinkId: string;
  enabled: boolean; deleted?: boolean; title: string; transcriptionLanguage?: TranscriptionLanguage;
  file?: { filename: string; contentType: string; size: number; contentHash: string };
  kind?: 'course' | 'youtube'; youtubeVideoId?: string;
};

/** Source kinds remain exclusive, including disabled/deleted material updates. */
export function validResourceManifestSource(value: Pick<ResourceManifest,
  'enabled' | 'deleted' | 'kind' | 'file' | 'youtubeVideoId' | 'transcriptionLanguage'>): boolean {
  return !(value.enabled && value.deleted) && (value.kind === 'course'
    ? value.file === undefined && value.youtubeVideoId === undefined && value.transcriptionLanguage === undefined
    : value.kind === 'youtube'
      ? value.file === undefined && value.transcriptionLanguage === undefined && (!value.enabled || value.youtubeVideoId !== undefined)
      : value.youtubeVideoId === undefined && (!value.enabled || value.file !== undefined));
}
