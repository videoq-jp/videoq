import { prepareVideoUpload as prepare, runUploadWorkflow as run } from '../application/video-upload';
import type { UploadDraft, UploadApi, UploadFailure, PreparedUpload as ApplicationUpload } from '../application/video-upload';
export type { UploadSourceMode } from '../application/video-upload';

/** Browser File is adapted at the UI boundary; application contracts are structural. */
export type PreparedUpload = ApplicationUpload<File>;
const failureMessages = {
  no_file: 'videos.upload.validation.noFile',
  invalid_file_type: 'videos.upload.validation.invalidFileType',
  file_too_large: 'videos.upload.validation.fileTooLarge',
  no_youtube_url: 'videos.upload.validation.noYoutubeUrl',
  no_title: 'videos.upload.validation.noTitle',
} as const satisfies Record<UploadFailure, string>;

export function prepareVideoUpload(input: UploadDraft<File>) {
  const result = prepare(input);
  if (result.isValid) return result;
  return { isValid: false as const, error: failureMessages[result.error],
    ...(result.maxSizeMb === undefined ? {} : { errorParams: { max_size_mb: result.maxSizeMb } }),
  };
}
export async function runUploadWorkflow(upload: PreparedUpload, tagIds: number[], api: UploadApi<File>, onProgress?: (percent: number) => void) {
  const warning = await run(upload, tagIds, api, onProgress);
  return warning === 'tags_failed' ? 'videos.upload.warning.tagsFailed' as const : null;
}
