import { ApplicationError } from '../../application/errors';
import { validResourceManifestSource } from '../../domain/lms/lms-resource';
import { lmsIdentity, sourceRevision } from './contracts';
import { z } from "zod";
import { fileExtension, isAllowedContentType, isAllowedExtension } from "../../lib/upload";
import { MAX_SINGLE_UPLOAD_BYTES, TRANSCRIPTION_LANGUAGES } from "@videoq/domain/video-upload";

const identity = lmsIdentity;
export const resourceManifestSchema = z.object({
  generation: z.number().int().positive().safe(),
  contextId: identity,
  courseTitle: z.string().trim().min(1).max(255).optional(),
  resourceLinkId: identity,
  enabled: z.boolean(),
  deleted: z.boolean().optional(),
  title: z.string().trim().min(1).max(255),
  transcriptionLanguage: z.enum(Object.keys(TRANSCRIPTION_LANGUAGES) as [keyof typeof TRANSCRIPTION_LANGUAGES, ...Array<keyof typeof TRANSCRIPTION_LANGUAGES>]).optional(),
  file: z.object({
    filename: z.string().min(1).max(255).refine(value => isAllowedExtension(fileExtension(value))),
    contentType: z.string().refine(isAllowedContentType),
    size: z.number().int().positive().safe().max(MAX_SINGLE_UPLOAD_BYTES),
    // Opaque source revision digest; existing SHA-1 and new SHA-256 connectors coexist.
    contentHash: sourceRevision,
  }).strict().optional(),
  // Omitted for video manifests: preserve the existing canonical JSON/hash.
  kind: z.enum(['course', 'youtube']).optional(),
  youtubeVideoId: z.string().length(11).regex(/^(?=.*[A-Za-z0-9])[A-Za-z0-9_-]{11}$/).optional(),
}).strict().refine(validResourceManifestSource,
"Enabled materials require their source identity; source kinds cannot mix media or be deleted while enabled");
export type { ResourceManifest } from "../../domain/lms/lms-resource";

export class LmsSyncError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413, public readonly code: string) {
    super(code);
  }
}

/** Preserve the connector transport's existing error class and flat error envelope. */
export function asLmsSyncError(error: unknown): LmsSyncError | null {
  if (error instanceof LmsSyncError) return error;
  if (error instanceof ApplicationError) {
    if (error.kind === 'conflict') return new LmsSyncError(409, error.code);
    if (error.kind === 'forbidden') return new LmsSyncError(403, error.code);
    if (error.kind === 'validation') return new LmsSyncError(400, error.code);
  }
  return null;
}
