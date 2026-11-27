import { videoTitleSchema, uploadFilenameSchema, uploadContentTypeSchema, uploadFileSizeSchema } from '@videoq/trpc/video-upload';
import { courseNameSchema } from '@videoq/trpc/course-name';
import { z } from "zod";
import { defineTool, type ToolDefinition, type ToolMetadata } from "./definition";
import { ToolError } from "./errors";
export { ToolError } from "./errors";
import { videoSourceTypeSchema, videoStatusSchema } from "@videoq/trpc";
import { visualProcessingSchema } from "@videoq/trpc/schema";
import type { Bindings } from "../types/bindings";
import { sha256Hex } from "../shared/crypto";
import { listVideosPage, getVideoDetail, getVideoMetadata } from "../repositories/video-repository";
import { listCoursesPage, getCourseDetail } from "../repositories/course-repository";
import { listTagsPage } from "../repositories/tag-repository";
import {
  getCourseChatHistory,
  getCourseChatAnalytics,
} from "../repositories/chat-repository";
import * as courseService from "../integrations/courses";
import * as membershipService from "../features/membership/service";
import * as videoService from "../features/videos/service";
import type { CreationIdempotency } from "../repositories/mcp-idempotency-repository";

type Json = Record<string, unknown>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CHAT_DEFAULT_LIMIT = 10;
const CHAT_MAX_LIMIT = 25;
const TRANSCRIPT_DEFAULT_LIMIT = 8_000;
const TRANSCRIPT_MAX_LIMIT = 20_000;

// MCP clients may send decimal strings, but booleans/arrays must never become IDs.
function integerInput(schema: z.ZodNumber) {
  return z.union([
    schema,
    z.string().regex(/^[0-9]+$/).transform(Number).pipe(schema),
  ]);
}
const intId = integerInput(z.number().int().positive().safe());
const description = z.string().max(10_000).default("");
const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe(
    "Stable unique key for this logical operation. Reuse it only when retrying the same input.",
  );

function paginationShape(defaultLimit: number, maxLimit: number) {
  return {
    limit: integerInput(z.number().int().min(1).max(maxLimit))
      .default(defaultLimit)
      .describe(`Max items to return (default ${defaultLimit}, max ${maxLimit}).`),
    offset: integerInput(z.number().int().min(0))
      .default(0)
      .describe("Number of items to skip."),
  };
}

const listPaginationShape = paginationShape(DEFAULT_LIMIT, MAX_LIMIT);
const chatPaginationShape = paginationShape(CHAT_DEFAULT_LIMIT, CHAT_MAX_LIMIT);

function envelope(
  items: unknown[],
  count: number,
  itemsKey: string,
  limit: number,
  offset: number,
): Json {
  return {
    meta: {
      total: count,
      limit,
      offset,
      has_more: offset + items.length < count,
      next_offset: offset + items.length < count ? offset + items.length : null,
    },
    [itemsKey]: items,
  };
}

export type ToolActorContext = {
  signal?: AbortSignal;
  env: Bindings;
  userId: string;
  canWrite: boolean;
  authVia?: string;
  requestId?: string;
};

/** Shared strict schemas for SDK registration and direct tool calls. */
export const managementToolSchemas = {
  list_videos: z.strictObject({
    q: z.string().max(255).optional(),
    status: videoStatusSchema.optional(),
    ordering: z
      .enum([
        "uploaded_at_desc",
        "uploaded_at_asc",
        "title_asc",
        "title_desc",
      ])
      .optional(),
    tags: z.array(intId).max(100).optional(),
    ...listPaginationShape,
  }),
  get_video: z.strictObject({
    video_id: intId,
    include_transcript: z.boolean().optional().default(false),
    transcript_offset: integerInput(z.number().int().min(0)).default(0),
    transcript_limit: integerInput(z.number().int().min(1).max(TRANSCRIPT_MAX_LIMIT))
      .default(TRANSCRIPT_DEFAULT_LIMIT),
  }),
  request_video_upload: z.strictObject({
    idempotency_key: idempotencyKey,
    filename: uploadFilenameSchema,
    content_type: uploadContentTypeSchema,
    file_size: integerInput(uploadFileSizeSchema),
    title: videoTitleSchema,
    description,
  }),
  confirm_video_upload: z.strictObject({
    video_id: intId,
  }),
  create_youtube_video: z.strictObject({
    idempotency_key: idempotencyKey,
    youtube_url: z.string().trim().url().max(200),
    title: videoTitleSchema,
    description,
  }),
  list_courses: z.strictObject({
    ...listPaginationShape,
  }),
  get_course: z.strictObject({
    course_id: intId,
    video_limit: integerInput(z.number().int().min(1).max(50)).default(20),
    video_offset: integerInput(z.number().int().min(0)).default(0),
  }),
  create_course: z.strictObject({
    idempotency_key: idempotencyKey,
    name: courseNameSchema,
    description,
  }),
  add_video_to_course: z.strictObject({
    course_id: intId,
    video_id: intId,
  }),
  list_tags: z.strictObject({
    ...listPaginationShape,
  }),
  get_chat_history: z.strictObject({
    course_id: intId,
    ...chatPaginationShape,
  }),
  get_chat_analytics: z.strictObject({
    course_id: intId,
  }),
} as const;

export type ManagementToolName = keyof typeof managementToolSchemas;

const pageMeta = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().nullable(),
});

const videoTag = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  color: z.string(),
});

const transcriptChunk = z.object({
  text: z.string(),
  offset: z.number().int().nonnegative(),
  returned_chars: z.number().int().nonnegative(),
  total_chars: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative().nullable(),
});

/**
 * MCP deliberately omits `file`, `user`, and the unbounded transcript string.
 * Detail responses may expose a bounded transcript chunk and transcript metadata.
 */
const compactVideoOutput = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  uploaded_at: z.string(),
  status: videoStatusSchema,
  visual_processing: visualProcessingSchema.nullable().optional(),
  source_type: videoSourceTypeSchema,
  source_url: z.string().nullable(),
  youtube_video_id: z.string().nullable(),
  youtube_embed_url: z.string().nullable(),
  tags: z.array(videoTag),
  error_message: z.string().nullable().optional(),
  transcript_available: z.boolean().optional(),
  transcript_total_chars: z.number().int().nonnegative().optional(),
  transcript: transcriptChunk.optional(),
});

const courseListItem = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  display_order: z.number().int(),
  created_at: z.string(),
  video_count: z.number().int().nonnegative(),
  access_role: z.enum(["owner", "member"]),
});

const courseDetail = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  display_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  video_count: z.number().int().nonnegative(),
  share_slug: z.string().nullable(),
  access_role: z.enum(["owner", "member", "public"]),
  videos: z.array(compactVideoOutput.extend({ order: z.number().int() })),
});

const tagListItem = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  color: z.string(),
  created_at: z.string(),
  video_count: z.number().int().nonnegative(),
});

const citation = z.object({
  id: z.number().int().positive(),
  video_id: z.number().int().positive(),
  title: z.string(),
  start_time: z.string().nullable(),
  end_time: z.string().nullable(),
});

const chatHistoryItem = z.object({
  id: z.number().int().positive(),
  course: z.number().int().positive(),
  asked_by: z.object({
    user_id: z.string(),
    username: z.string(),
    email: z.string(),
  }).nullable(),
  question: z.string(),
  answer: z.string(),
  citations: z.array(citation),
  is_shared_origin: z.boolean(),
  feedback: z.enum(["good", "bad"]).nullable(),
  created_at: z.string(),
});

const chatAnalytics = z.object({
  summary: z.object({
    total_questions: z.number().int().nonnegative(),
    date_range: z.object({
      first: z.string().nullable(),
      last: z.string().nullable(),
    }),
  }),
  time_series: z.array(z.object({
    date: z.string(),
    count: z.number().int().nonnegative(),
  })),
  feedback: z.object({
    good: z.number().int().nonnegative(),
    bad: z.number().int().nonnegative(),
    none: z.number().int().nonnegative(),
  }),
});

/** Successful structuredContent contracts. Tool errors use their own error envelope. */
export const managementToolOutputSchemas = {
  list_videos: { meta: pageMeta, videos: z.array(compactVideoOutput) },
  get_video: { video: compactVideoOutput },
  request_video_upload: {
    video: compactVideoOutput,
    reused: z.boolean(),
    already_confirmed: z.boolean(),
    upload: z.object({
      method: z.literal("PUT"),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()),
      expires_in_seconds: z.number().int().positive(),
    }).nullable(),
    next_step: z.object({
      tool: z.literal("confirm_video_upload"),
      arguments: z.object({ video_id: z.number().int().positive() }),
    }).nullable(),
  },
  confirm_video_upload: { video: compactVideoOutput, reused: z.boolean() },
  create_youtube_video: { video: compactVideoOutput, reused: z.boolean() },
  list_courses: { meta: pageMeta, courses: z.array(courseListItem) },
  get_course: { course: courseDetail, videos_meta: pageMeta },
  create_course: { course: courseDetail, reused: z.boolean() },
  add_video_to_course: {
    result: z.object({
      ok: z.literal(true),
      message: z.string(),
      id: z.number().int().positive(),
      reused: z.boolean(),
    }),
  },
  list_tags: { meta: pageMeta, tags: z.array(tagListItem) },
  get_chat_history: { meta: pageMeta, history: z.array(chatHistoryItem) },
  get_chat_analytics: { analytics: chatAnalytics },
} as const;

export const MANAGEMENT_WRITE_TOOLS = new Set<ManagementToolName>([
  "request_video_upload",
  "confirm_video_upload",
  "create_youtube_video",
  "create_course",
  "add_video_to_course",
]);

export const MANAGEMENT_TOOL_TITLES: Record<ManagementToolName, string> = {
  list_videos: "List videos",
  get_video: "Get video details",
  request_video_upload: "Prepare video upload",
  confirm_video_upload: "Confirm video upload",
  create_youtube_video: "Import YouTube video",
  list_courses: "List courses",
  get_course: "Get course details",
  create_course: "Create course",
  add_video_to_course: "Add video to course",
  list_tags: "List tags",
  get_chat_history: "Get chat history",
  get_chat_analytics: "Get chat analytics",
};

export const MANAGEMENT_TOOL_DESCRIPTIONS = {
  list_videos:
    "List your videos. Supports keyword, status, ordering, tag filters, " +
    "and bounded limit/offset pagination. Download URLs are omitted.",
  get_video:
    "Get compact video details. Set include_transcript=true to receive one bounded " +
    "transcript chunk; continue with transcript_offset when has_more is true.",
  request_video_upload:
    "Idempotently reserve storage and create a video upload. Returns a signed PUT URL, " +
    "required headers, and the confirm_video_upload arguments. Upload the local " +
    "file to that URL before confirming. A retry after confirmation reports the current " +
    "video state without issuing another PUT URL.",
  confirm_video_upload:
    "Confirm that a file was uploaded with request_video_upload and start processing it.",
  create_youtube_video:
    "Idempotently register a YouTube video by URL and start importing it into VideoQ.",
  list_courses: "List your video courses. Supports limit/offset pagination.",
  get_course:
    "Get a video course and a bounded page of member videos. Use video_limit/video_offset to continue.",
  create_course: "Idempotently create a video course owned by the authenticated user.",
  add_video_to_course:
    "Idempotently add one of the authenticated user's videos to a course they own.",
  list_tags: "List your tags. Supports limit/offset pagination.",
  get_chat_history:
    "Get chat history for an owned course. Each entry includes question, answer, " +
    "author, feedback (good/bad/null), citations, and timestamps. " +
    "Supports limit/offset pagination.",
  get_chat_analytics:
    "Get aggregated chat analytics for a course: total question count, " +
    "date range, daily time series, and feedback breakdown (good/bad/none).",
} as const;

function requireWrite(ctx: ToolActorContext): void {
  if (!ctx.canWrite) {
    throw new ToolError("Write permission is required for this tool.", {
      status: 403,
      code: "FORBIDDEN",
    });
  }
}

function firstFieldError(fieldError: Record<string, readonly string[] | undefined> | undefined): string {
  return fieldError ? Object.values(fieldError)[0]?.[0] ?? "Invalid input" : "Invalid input";
}

async function creationIdempotency(
  action: CreationIdempotency["action"],
  key: string,
  payload: Json,
): Promise<CreationIdempotency> {
  return {
    action,
    key,
    requestHash: await sha256Hex(JSON.stringify(payload)),
  };
}

/** MCP/LLM の文脈へ短命な download URL・内部 user id・全文 transcript を出さない。 */
function compactVideo(value: unknown): Json {
  const video = (value ?? {}) as Record<string, unknown>;
  const hasTranscript = Object.prototype.hasOwnProperty.call(video, "transcript");
  const { file: _file, user: _user, transcript, ...rest } = video;
  const transcriptText = typeof transcript === "string" ? transcript : "";
  return {
    ...rest,
    ...(hasTranscript
      ? {
          transcript_available: transcriptText.length > 0,
          transcript_total_chars: transcriptText.length,
        }
      : {}),
  };
}

function compactCourse(value: unknown): Json {
  const course = (value ?? {}) as Record<string, unknown>;
  const videos = Array.isArray(course.videos)
    ? course.videos.map((video) => compactVideo(video))
    : [];
  return { ...course, videos };
}

const readOnly: NonNullable<ToolMetadata["annotations"]> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const additiveIdempotent: NonNullable<ToolMetadata["annotations"]> = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MANAGEMENT_TOOL_ANNOTATIONS: Record<ManagementToolName, NonNullable<ToolMetadata["annotations"]>> = {
  list_videos: readOnly,
  get_video: readOnly,
  request_video_upload: {
    ...additiveIdempotent,
    openWorldHint: true,
  },
  confirm_video_upload: {
    ...additiveIdempotent,
    // A mismatched upload is removed while its storage reservation is released.
    destructiveHint: true,
    openWorldHint: true,
  },
  create_youtube_video: {
    ...additiveIdempotent,
    openWorldHint: true,
  },
  list_courses: readOnly,
  get_course: readOnly,
  create_course: additiveIdempotent,
  add_video_to_course: additiveIdempotent,
  list_tags: readOnly,
  get_chat_history: readOnly,
  get_chat_analytics: readOnly,
};

const managementOutputContracts: Record<string, z.ZodObject> = Object.fromEntries(
  Object.entries(managementToolOutputSchemas).map(([name, shape]) => [name, z.object(shape)]),
);

/** Actor-scoped definitions shared by every transport. */
export function createManagementTools(ctx: ToolActorContext): ToolDefinition[] {
  function define<Name extends ManagementToolName>(name: Name, execute: (args: z.output<(typeof managementToolSchemas)[Name]>) => Promise<Json>): ToolDefinition {
    return defineTool(execute, {
      name, title: MANAGEMENT_TOOL_TITLES[name], description: MANAGEMENT_TOOL_DESCRIPTIONS[name],
      schema: managementToolSchemas[name], outputSchema: managementOutputContracts[name],
      resultFormat: "flat", failureMode: "propagate", annotations: MANAGEMENT_TOOL_ANNOTATIONS[name],
      access: MANAGEMENT_WRITE_TOOLS.has(name) ? "write" : "read",
    });
  }
  return [
    define("list_videos", async args => {
      const { limit, offset } = args;
      const page = await listVideosPage(
        ctx.env,
        ctx.userId,
        {
          keyword: (args.q ?? "").trim(),
          statusFilter: args.status ?? "",
          sortKey: args.ordering ?? "",
          tagIds: args.tags ?? null,
        },
        limit,
        offset,
        { includeFileUrls: false },
      );
      return envelope(
        page.results.map((video) => compactVideo(video)),
        page.count,
        "videos",
        limit,
        offset,
      );
    }),
    define("get_video", async args => {
      const videoId = args.video_id;
      const video = args.include_transcript === true
        ? await getVideoDetail(ctx.env, videoId, ctx.userId, { includeFileUrl: false })
        : await getVideoMetadata(ctx.env, videoId, ctx.userId);
      if (!video) {
        throw new ToolError("Video not found", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      const result = compactVideo(video);
      if ("transcript" in video) {
        const transcript = video.transcript ?? "";
        const offset = args.transcript_offset;
        const limit = args.transcript_limit;
        const end = Math.min(transcript.length, offset + limit);
        result.transcript = {
          text: transcript.slice(offset, end),
          offset,
          returned_chars: Math.max(0, end - offset),
          total_chars: transcript.length,
          has_more: end < transcript.length,
          next_offset: end < transcript.length ? end : null,
        };
      }
      return { video: result };
    }),
    define("request_video_upload", async args => {
      requireWrite(ctx);
      const contentType = args.content_type;
      const fileSize = args.file_size;
      const payload = {
        filename: args.filename,
        content_type: contentType,
        file_size: fileSize,
        title: args.title,
        description: args.description,
      };
      const result = await videoService.requestPresignedUpload(
        ctx.env,
        ctx.userId,
        payload,
        await creationIdempotency(
          "request_video_upload",
          args.idempotency_key,
          payload,
        ),
      );
      if ("idempotencyConflict" in result) {
        throw new ToolError(
          "The idempotency key was already used with different upload arguments.",
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
      }
      if ("fieldError" in result) {
        throw new ToolError(firstFieldError(result.fieldError), {
          status: 400,
          code: "VALIDATION_ERROR",
          details: result.fieldError,
        });
      }
      if ("badRequest" in result) {
        throw new ToolError(result.badRequest ?? "Invalid upload request.", {
          status: 400,
          code: "code" in result ? result.code : "VALIDATION_ERROR",
        });
      }
      if (!result.video || !result.upload_url) {
        if (result.video && result.already_confirmed) {
          return {
            video: compactVideo(result.video),
            reused: true,
            already_confirmed: true,
            upload: null,
            next_step: null,
          };
        }
        throw new ToolError("The upload could not be prepared.", {
          status: 500,
          code: "INTERNAL_ERROR",
        });
      }
      return {
        video: compactVideo(result.video),
        reused: result.reused,
        already_confirmed: false,
        upload: {
          method: "PUT",
          url: result.upload_url,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(fileSize),
          },
          expires_in_seconds: 3600,
        },
        next_step: {
          tool: "confirm_video_upload",
          arguments: { video_id: result.video.id },
        },
      };
    }),
    define("confirm_video_upload", async args => {
      requireWrite(ctx);
      const result = await videoService.confirmVideoUpload(
        ctx.env,
        args.video_id,
        ctx.userId,
      );
      if ("notFound" in result) {
        throw new ToolError("Video not found", { status: 404, code: "NOT_FOUND" });
      }
      if ("badState" in result) {
        throw new ToolError(result.message ?? "The video is not ready to confirm.", {
          status: 400,
          code: "INVALID_STATE",
        });
      }
      if (!result.video) {
        throw new ToolError("The video upload could not be confirmed.", {
          status: 500,
          code: "INTERNAL_ERROR",
        });
      }
      return {
        video: compactVideo(result.video),
        reused: result.alreadyConfirmed,
      };
    }),
    define("create_youtube_video", async args => {
      requireWrite(ctx);
      const payload = {
        youtube_url: args.youtube_url,
        title: args.title,
        description: args.description,
      };
      const result = await videoService.createUserYoutubeVideo(
        ctx.env,
        ctx.userId,
        payload,
        await creationIdempotency(
          "create_youtube_video",
          args.idempotency_key,
          payload,
        ),
      );
      if ("idempotencyConflict" in result) {
        throw new ToolError(
          "The idempotency key was already used with different YouTube arguments.",
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
      }
      if ("fieldError" in result) {
        throw new ToolError(firstFieldError(result.fieldError), {
          status: 400,
          code: "VALIDATION_ERROR",
          details: result.fieldError,
        });
      }
      if (!result.video) {
        throw new ToolError("The YouTube video could not be created.", {
          status: 500,
          code: "INTERNAL_ERROR",
        });
      }
      return { video: compactVideo(result.video), reused: result.reused };
    }),
    define("list_courses", async args => {
      const { limit, offset } = args;
      const page = await listCoursesPage(ctx.env, ctx.userId, limit, offset);
      return envelope(page.results, page.count, "courses", limit, offset);
    }),
    define("get_course", async args => {
      const videoLimit = args.video_limit;
      const videoOffset = args.video_offset;
      const course = await getCourseDetail(
        ctx.env,
        args.course_id,
        ctx.userId,
        {
          includeFileUrls: false,
          videoLimit,
          videoOffset,
        },
      );
      if (!course) {
        throw new ToolError("Course not found", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      const videos = course.videos;
      const courseResult = compactCourse(course);
      return {
        course: courseResult,
        videos_meta: {
          total: course.video_count,
          limit: videoLimit,
          offset: videoOffset,
          has_more: videoOffset + videos.length < course.video_count,
          next_offset:
            videoOffset + videos.length < course.video_count
              ? videoOffset + videos.length
              : null,
        },
      };
    }),
    define("create_course", async args => {
      requireWrite(ctx);
      const payload = {
        name: args.name,
        description: args.description,
      };
      const result = await courseService.createUserCourseIdempotent(
        ctx.env,
        ctx.userId,
        payload.name,
        payload.description,
        await creationIdempotency(
          "create_course",
          args.idempotency_key,
          payload,
        ),
      );
      if ("idempotencyConflict" in result) {
        throw new ToolError(
          "The idempotency key was already used with different course arguments.",
          { status: 409, code: "IDEMPOTENCY_CONFLICT" },
        );
      }
      if (!result.course) {
        throw new ToolError("The course could not be created.", {
          status: 500,
          code: "INTERNAL_ERROR",
        });
      }
      return { course: compactCourse(result.course), reused: result.reused };
    }),
    define("add_video_to_course", async args => {
      requireWrite(ctx);
      const result = await membershipService.addVideoToCourseOne(
        ctx.env,
        ctx.userId,
        args.course_id,
        args.video_id,
      );
      if ("notFound" in result) {
        throw new ToolError(result.notFound ?? "Resource not found", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      return { result };
    }),
    define("list_tags", async args => {
      const { limit, offset } = args;
      const page = await listTagsPage(ctx.env, ctx.userId, limit, offset);
      return envelope(page.results, page.count, "tags", limit, offset);
    }),
    define("get_chat_history", async args => {
      const { limit, offset } = args;
      const res = await getCourseChatHistory(
        ctx.env,
        args.course_id,
        ctx.userId,
        limit,
        offset,
      );
      if ("notFound" in res) {
        throw new ToolError("Course not found", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      return envelope(res.results, res.count, "history", limit, offset);
    }),
    define("get_chat_analytics", async args => {
      const res = await getCourseChatAnalytics(
        ctx.env,
        args.course_id,
        ctx.userId,
      );
      if ("notFound" in res) {
        throw new ToolError("Course not found", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      return { analytics: res };
    }),
  ];
}

/** Direct callers use the same definitions and validation as MCP. */
export async function callManagementTool(name: string, args: Json, ctx: ToolActorContext): Promise<Json> {
  const definition = createManagementTools(ctx).find(tool => tool.name === name);
  if (!definition) throw new ToolError(`Unknown tool: ${name}`);
  return await definition.invoke(args, { signal: ctx.signal ?? new AbortController().signal }) as Json;
}
