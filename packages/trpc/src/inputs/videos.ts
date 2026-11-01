import { z } from "zod";
import { MAX_UPLOAD_PARTS, MAX_VIDEO_UPLOAD_BYTES, TRANSCRIPTION_LANGUAGES } from "../video-upload";

const id = z.number().int().positive();
const title = z.string().trim().min(1).max(255);

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
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(100),
    fileSize: z.number().int().positive().max(MAX_VIDEO_UPLOAD_BYTES),
    multipart: z.boolean().optional(),
    transcriptionLanguage: z.enum(Object.keys(TRANSCRIPTION_LANGUAGES) as [keyof typeof TRANSCRIPTION_LANGUAGES, ...Array<keyof typeof TRANSCRIPTION_LANGUAGES>]).optional(),
    title,
    description: z.string().default(""),
  }),
  "videos.confirmUpload": z.object({ id }),
  "videos.uploadPartUrl": z.object({ id, partNumber: z.number().int().min(1).max(MAX_UPLOAD_PARTS) }),
  "videos.completeMultipartUpload": z.object({
    id,
    parts: z.array(z.object({
      partNumber: z.number().int().min(1).max(MAX_UPLOAD_PARTS),
      etag: z.string().regex(/^[a-fA-F0-9]{32}$/),
    })).min(1).max(MAX_UPLOAD_PARTS),
  }),
  "videos.abortUpload": z.object({ id }),
  "videos.createYoutube": z.object({ youtubeUrl: z.string().trim().min(1), title, description: z.string().default("") }),
  "videos.update": z.object({
    id,
    title: title.optional(),
    description: z.string().optional(),
    transcript: z.string().optional(),
  }),
  "videos.delete": z.object({ id }),
};
