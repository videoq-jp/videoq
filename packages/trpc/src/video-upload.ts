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
