import { beforeEach, describe, expect, it, vi } from "vitest";
import { callManagementTool } from "../src/tools/management";
import { getVideoMetadata, listVideosPage } from "../src/repositories/video-repository";
import { getCourseDetail, listCoursesPage } from "../src/repositories/course-repository";
import { listTagsPage } from "../src/repositories/tag-repository";
import { getCourseChatHistory } from "../src/repositories/chat-repository";
import { addVideoToCourseOne } from "../src/features/membership/service";
import { requestPresignedUpload } from "../src/features/videos/service";

vi.mock("../src/repositories/video-repository", () => ({ getVideoMetadata: vi.fn(), listVideosPage: vi.fn() }));
vi.mock("../src/repositories/course-repository", () => ({ getCourseDetail: vi.fn(), listCoursesPage: vi.fn() }));
vi.mock("../src/repositories/tag-repository", () => ({ listTagsPage: vi.fn() }));
vi.mock("../src/repositories/chat-repository", () => ({ getCourseChatHistory: vi.fn() }));
vi.mock("../src/features/membership/service", () => ({ addVideoToCourseOne: vi.fn() }));
vi.mock("../src/features/videos/service", () => ({ requestPresignedUpload: vi.fn() }));

const context = { env: {} as never, userId: "user-1", canWrite: true };
const upload = {
  idempotency_key: "upload-input-1", filename: "lecture.mp4", content_type: "video/mp4",
  title: "Lecture", file_size: 42,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getVideoMetadata).mockResolvedValue(null);
  vi.mocked(addVideoToCourseOne).mockResolvedValue({ notFound: "Video not found" });
  vi.mocked(requestPresignedUpload).mockResolvedValue({ badRequest: "No upload" } as never);
  for (const read of [listVideosPage, listCoursesPage, listTagsPage, getCourseChatHistory]) {
    vi.mocked(read).mockResolvedValue({ results: [], count: 0 });
  }
});

describe("MCP numeric input boundaries", () => {
  const invalidValues = [true, [42], "0x2a", "4.2e1", " 42 "];
  it.each(invalidValues)("rejects ambiguous numeric value %j before reads or writes", async (value) => {
    for (const [name, args] of [
      ["get_video", { video_id: value }],
      ["add_video_to_course", { course_id: 7, video_id: value }],
      ["request_video_upload", { ...upload, file_size: value }],
      ["list_videos", { limit: value }],
    ] as const) {
      await expect(callManagementTool(name, args, context)).rejects.toMatchObject({
        data: { status: 400, code: "VALIDATION_ERROR" },
      });
    }
    for (const operation of [getVideoMetadata, addVideoToCourseOne, requestPresignedUpload, listVideosPage]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it.each([true, false, null, [], ""])("rejects ambiguous pagination offset %j", async (offset) => {
    await expect(callManagementTool("list_videos", { offset }, context)).rejects.toMatchObject({
      data: { status: 400, code: "VALIDATION_ERROR" },
    });
    expect(listVideosPage).not.toHaveBeenCalled();
  });

  it.each([1, "42", "00042", Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])(
    "preserves valid integer ID %j", async (videoId) => {
      await expect(callManagementTool("get_video", { video_id: videoId }, context)).rejects.toMatchObject({
        data: { status: 404, code: "NOT_FOUND" },
      });
      expect(getVideoMetadata).toHaveBeenCalledWith(context.env, Number(videoId), context.userId);
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "9007199254740993"])(
    "rejects out-of-range ID %j", async (videoId) => {
      await expect(callManagementTool("get_video", { video_id: videoId }, context)).rejects.toMatchObject({
        data: { status: 400, code: "VALIDATION_ERROR" },
      });
      expect(getVideoMetadata).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["list_videos", {}, 20], ["list_courses", {}, 20], ["list_tags", {}, 20],
    ["get_chat_history", { course_id: 7 }, 10],
  ] as const)("uses schema pagination defaults for %s", async (name, args, limit) => {
    expect(await callManagementTool(name, args, context)).toMatchObject({ meta: { limit, offset: 0 } });
  });

  it("passes numeric pagination strings as numbers without changing their values", async () => {
    await callManagementTool("list_videos", { limit: "7", offset: "12" }, context);
    expect(listVideosPage).toHaveBeenCalledWith(context.env, context.userId, expect.any(Object), 7, 12, { includeFileUrls: false });
  });

  it("preserves the defaults for course video pagination", async () => {
    vi.mocked(getCourseDetail).mockResolvedValue(null);
    await expect(callManagementTool("get_course", { course_id: "7" }, context)).rejects.toMatchObject({
      data: { status: 404, code: "NOT_FOUND" },
    });
    expect(getCourseDetail).toHaveBeenCalledWith(context.env, 7, context.userId, {
      includeFileUrls: false, videoLimit: 20, videoOffset: 0,
    });
  });

  it.each(["toString", "__proto__", "no_such_tool"])("rejects unknown tool %s", async (name) => {
    await expect(callManagementTool(name, {}, context)).rejects.toMatchObject({
      name: "ToolError", message: `Unknown tool: ${name}`,
    });
  });
});
