import { z } from "zod";
import { fileExtension, isAllowedContentType, isAllowedExtension } from "../../lib/upload";
import { MAX_SINGLE_UPLOAD_BYTES } from "@videoq/trpc/video-upload";

const identity = z.string().min(1).max(255);
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
    // Moodle's stored_file contenthash is SHA-1, used as a source revision ID.
    contentHash: z.string().regex(/^[a-f0-9]{40}$/),
  }).strict().optional(),
  // Omitted for video manifests: preserve the existing canonical JSON/hash.
  kind: z.literal('course').optional(),
}).strict().refine(value => value.kind === 'course'
  ? value.file === undefined && !(value.enabled && value.deleted)
  : !value.enabled || (value.file !== undefined && !value.deleted),
"Course entries cannot contain files; enabled video resources require a file and cannot be deleted");
export type ResourceManifest = z.infer<typeof resourceManifestSchema>;

export class LmsSyncError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 413, public readonly code: string) {
    super(code);
  }
}
