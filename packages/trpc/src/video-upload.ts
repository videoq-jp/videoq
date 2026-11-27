import { MAX_YOUTUBE_URL_LENGTH, youtubeUrlTextFailure, youtubeVideoIdFromParts, INVALID_YOUTUBE_URL_MESSAGE } from '@videoq/domain/youtube';
/** Compatibility export; shared policies belong to the domain package. */
export * from "@videoq/domain/video-upload";

import { z } from 'zod';
import { videoTitleFailure, uploadFilenameFailure, uploadContentTypeFailure, uploadSizeFailure, TRANSCRIPTION_LANGUAGES } from '@videoq/domain/video-upload';
function metadataString(failure: (value: string) => string | null) {
  return z.string().trim().superRefine((value, ctx) => {
    const error = failure(value);
    if (error) ctx.addIssue({ code: 'custom', message: error });
  });
}
export const videoTitleSchema = metadataString(videoTitleFailure);
export const uploadFilenameSchema = metadataString(uploadFilenameFailure);
export const uploadContentTypeSchema = metadataString(uploadContentTypeFailure);
export const uploadFileSizeSchema = z.number().refine(value => uploadSizeFailure(value) === null, 'Invalid file size.');
export const transcriptionLanguageSchema = z.enum(Object.keys(TRANSCRIPTION_LANGUAGES) as [keyof typeof TRANSCRIPTION_LANGUAGES, ...Array<keyof typeof TRANSCRIPTION_LANGUAGES>]);

/** URL parsing is an input-adapter concern; allowed parts and bounds are pure. */
export const youtubeUrlSchema = z.string().trim().min(1, INVALID_YOUTUBE_URL_MESSAGE).max(MAX_YOUTUBE_URL_LENGTH, INVALID_YOUTUBE_URL_MESSAGE).url(INVALID_YOUTUBE_URL_MESSAGE).superRefine((value, ctx) => {
  let error = youtubeUrlTextFailure(value);
  if (!error) {
    try {
      const parsed = new URL(value);
      if (!youtubeVideoIdFromParts({protocol:parsed.protocol,host:parsed.host,pathname:parsed.pathname,videoQuery:parsed.searchParams.get('v')})) error = INVALID_YOUTUBE_URL_MESSAGE;
    } catch { error = INVALID_YOUTUBE_URL_MESSAGE; }
  }
  if (error) ctx.addIssue({code:'custom',message:error});
});
