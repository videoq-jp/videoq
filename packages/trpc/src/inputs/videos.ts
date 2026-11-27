import { textValueSchema } from '../text-value';
import { z } from "zod";
import { isValidUploadPartEtag, MAX_UPLOAD_PARTS, youtubeUrlSchema, videoTitleSchema, uploadFilenameSchema, uploadContentTypeSchema, uploadFileSizeSchema, transcriptionLanguageSchema } from "../video-upload";

const id = z.number().int().positive();
const title = videoTitleSchema;

export const videosInputSchemas = {
  "videos.list": z.object({
    q: z.string().optional(),
    status: z.string().optional(),
    ordering: z.enum(["uploaded_at_desc", "uploaded_at_asc", "title_asc", "title_desc"]).optional(),
    tags: z.array(id).optional(),
    limit: z.number().int().positive().max(100).default(100),
    cursor: z.number().int().nonnegative().optional(),
  }).default({ limit: 100 }),
  "videos.statusCounts": z.undefined(),
  "videos.get": z.object({ id }),
  "videos.requestUpload": z.object({
    filename: uploadFilenameSchema,
    contentType: uploadContentTypeSchema,
    fileSize: uploadFileSizeSchema,
    multipart: z.boolean().optional(),
    transcriptionLanguage: transcriptionLanguageSchema.optional(),
    title,
    description: textValueSchema.default(""),
  }),
  "videos.confirmUpload": z.object({ id }),
  "videos.uploadPartUrl": z.object({ id, partNumber: z.number().int().min(1).max(MAX_UPLOAD_PARTS) }),
  "videos.completeMultipartUpload": z.object({
    id,
    parts: z.array(z.object({
      partNumber: z.number().int().min(1).max(MAX_UPLOAD_PARTS),
      etag: z.string().refine(isValidUploadPartEtag,{message:"Invalid upload part ETag"}),
    })).min(1).max(MAX_UPLOAD_PARTS),
  }),
  "videos.abortUpload": z.object({ id }),
  "videos.createYoutube": z.object({ youtubeUrl: youtubeUrlSchema, title, description: textValueSchema.default("") }),
  "videos.update": z.object({
    id,
    title: title.optional(),
    description: textValueSchema.optional(),
    transcript: textValueSchema.optional(),
  }),
  "videos.delete": z.object({ id }),
};
