import { lmsIdentity, sourceRevision } from './contracts';
import { z } from "zod";
import { fileExtension, isAllowedContentType, isAllowedExtension } from "../../lib/upload";
import { MAX_SINGLE_UPLOAD_BYTES } from "@videoq/trpc/video-upload";

const identity = lmsIdentity;
export const resourceManifestSchema = z.object({
  generation: z.number().int().positive().safe(),
  contextId: identity,
  courseTitle: z.string().trim().min(1).max(255).optional(),
  resourceLinkId: identity,
  enabled: z.boolean(),
  deleted: z.boolean().optional(),
  title: z.string().trim().min(1).max(255),
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
}).strict().refine(value => !(value.enabled && value.deleted) && (value.kind === 'course'
  ? value.file === undefined && value.youtubeVideoId === undefined
  : value.kind === 'youtube'
    ? value.file === undefined && (!value.enabled || value.youtubeVideoId !== undefined)
    : value.youtubeVideoId === undefined && (!value.enabled || value.file !== undefined)),
"Enabled materials require their source identity; source kinds cannot mix media or be deleted while enabled");
export type ResourceManifest = z.infer<typeof resourceManifestSchema>;

export class LmsSyncError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413, public readonly code: string) {
    super(code);
  }
}
