import { beforeEach, describe, expect, it, vi } from "vitest";
import * as courseService from "../src/integrations/courses";
import * as membershipService from "../src/features/membership/service";
import * as videoService from "../src/features/videos/service";
import { callMcpTool, McpToolError } from "../src/lib/mcp-tools";

vi.mock("../src/integrations/courses", () => ({
  createUserCourse: vi.fn(),
  createUserCourseIdempotent: vi.fn(),
}));

vi.mock("../src/features/membership/service", () => ({
  addVideoToCourseOne: vi.fn(),
}));

vi.mock("../src/features/videos/service", () => ({
  requestPresignedUpload: vi.fn(),
  confirmVideoUpload: vi.fn(),
  createUserYoutubeVideo: vi.fn(),
}));

const env = {} as never;
const writableContext = { env, userId: "user-1", canWrite: true };

describe("MCP write tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a signed upload recipe and confirmation arguments", async () => {
    vi.mocked(videoService.requestPresignedUpload).mockResolvedValue({
      video: { id: 42 },
      upload_url: "https://uploads.example/video",
      reused: false,
      already_confirmed: false,
    } as never);

    const result = await callMcpTool(
      "request_video_upload",
      {
        idempotency_key: "upload-lecture-1",
        filename: "lecture.mp4",
        content_type: "video/mp4",
        file_size: 1234,
        title: "Lecture",
      },
      writableContext,
    );

    expect(videoService.requestPresignedUpload).toHaveBeenCalledWith(
      env,
      "user-1",
      {
        filename: "lecture.mp4",
        content_type: "video/mp4",
        file_size: 1234,
        title: "Lecture",
        description: "",
      },
      expect.objectContaining({
        action: "request_video_upload",
        key: "upload-lecture-1",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(result).toMatchObject({
      video: { id: 42 },
      reused: false,
      already_confirmed: false,
      upload: {
        method: "PUT",
        url: "https://uploads.example/video",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "1234",
        },
      },
      next_step: {
        tool: "confirm_video_upload",
        arguments: { video_id: 42 },
      },
    });
  });

  it("does not return a replacement PUT URL after the upload was confirmed", async () => {
    vi.mocked(videoService.requestPresignedUpload).mockResolvedValue({
      video: { id: 42, status: "processing" },
      upload_url: null,
      reused: true,
      already_confirmed: true,
    } as never);

    await expect(
      callMcpTool(
        "request_video_upload",
        {
          idempotency_key: "upload-lecture-1",
          filename: "lecture.mp4",
          content_type: "video/mp4",
          file_size: 1234,
          title: "Lecture",
        },
        writableContext,
      ),
    ).resolves.toEqual({
      video: { id: 42, status: "processing" },
      reused: true,
      already_confirmed: true,
      upload: null,
      next_step: null,
    });
  });

  it("creates a course and adds a video to it", async () => {
    vi.mocked(courseService.createUserCourseIdempotent).mockResolvedValue({
      course: { id: 7, name: "Physics" },
      reused: false,
    } as never);
    vi.mocked(membershipService.addVideoToCourseOne).mockResolvedValue({
      ok: true,
      message: "Video added to course",
      id: 9,
    });

    await expect(
      callMcpTool(
        "create_course",
        {
          idempotency_key: "course-physics-1",
          name: "Physics",
          description: "Semester 1",
        },
        writableContext,
      ),
    ).resolves.toEqual({
      course: { id: 7, name: "Physics", videos: [] },
      reused: false,
    });

    await expect(
      callMcpTool(
        "add_video_to_course",
        { course_id: 7, video_id: 42 },
        writableContext,
      ),
    ).resolves.toEqual({
      result: { ok: true, message: "Video added to course", id: 9 },
    });
  });

  it("blocks writes before calling a service when permission is read-only", async () => {
    const call = callMcpTool(
      "create_course",
      { idempotency_key: "course-physics-1", name: "Physics" },
      { ...writableContext, canWrite: false },
    );
    await expect(call).rejects.toEqual(
      expect.objectContaining<McpToolError>({
        message: "Write permission is required for this tool.",
      }),
    );
    expect(courseService.createUserCourseIdempotent).not.toHaveBeenCalled();
  });

  it("treats repeated upload confirmation as a successful reuse", async () => {
    vi.mocked(videoService.confirmVideoUpload).mockResolvedValue({
      video: { id: 42, status: "pending", transcript: "" },
      alreadyConfirmed: true,
    } as never);

    await expect(
      callMcpTool(
        "confirm_video_upload",
        { video_id: 42 },
        writableContext,
      ),
    ).resolves.toMatchObject({
      video: { id: 42, status: "pending" },
      reused: true,
    });
  });

  it("returns an actionable conflict when an idempotency key changes payload", async () => {
    vi.mocked(videoService.createUserYoutubeVideo).mockResolvedValue({
      idempotencyConflict: true,
    } as never);

    await expect(
      callMcpTool(
        "create_youtube_video",
        {
          idempotency_key: "youtube-lecture-1",
          youtube_url: "https://www.youtube.com/watch?v=abcdefghijk",
          title: "Lecture",
        },
        writableContext,
      ),
    ).rejects.toEqual(
      expect.objectContaining<McpToolError>({
        message:
          "The idempotency key was already used with different YouTube arguments.",
      }),
    );
  });
});
