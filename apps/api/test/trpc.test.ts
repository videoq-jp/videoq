import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_USER_ID, testAuthHeaders } from "./helpers/auth";
import { TAG_COLORS } from "@videoq/trpc/schema";
import { apiConflict, apiServiceUnavailable } from "../src/shared/errors";
import * as auth from "../src/middleware/auth";
import * as messageService from "../src/features/chat/message-service";

const tagService = vi.hoisted(() => ({
  listTags: vi.fn(),
  createUserTag: vi.fn(),
  updateUserTag: vi.fn(),
  removeTag: vi.fn(),
}));

const courseService = vi.hoisted(() => ({
  listCourses: vi.fn(),
  createUserCourse: vi.fn(),
  reorderUserCourses: vi.fn(),
}));

const videoService = vi.hoisted(() => ({
  getUserVideoStats: vi.fn(),
  requestPresignedUpload: vi.fn(),
}));

vi.mock("../src/features/tags/service", () => tagService);
vi.mock("../src/features/courses/service", () => courseService);
vi.mock("../src/features/videos/service", () => videoService);

import { createApp } from "../src/app";

const ENV = {
  ENVIRONMENT: "development",
  BETTER_AUTH_SECRET: "trpc-visitor-session-test-secret",
  CORS_ALLOW_ORIGIN: "http://localhost:5173",
} as never;

const sampleTag = {
  id: 3,
  name: "Lecture",
  color: "blue",
  created_at: "2026-09-05T00:00:00.000Z",
  video_count: 0,
};

const sampleCourse = {
  id: 7,
  name: "Type-safe APIs",
  description: "Hono and React",
  display_order: 0,
  created_at: "2026-09-05T00:00:00.000Z",
  video_count: 2,
  access_role: "owner",
};

const sampleVideoStats = {
  total: 3,
  completed: 1,
  pending: 1,
  processing: 0,
  indexing: 1,
  error: 0,
  uploading: 0,
};

describe("tRPC Hono adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { outcome: { kind: "invalid", message: "Invalid session" } as const, status: 401, code: "UNAUTHORIZED" },
    { outcome: { kind: "forbidden", message: "Access denied", requiredScope: "read" } as const, status: 403, code: "FORBIDDEN" },
  ])("preserves an explicit authentication refusal for shared chat: $code", async ({ outcome, status, code }) => {
    vi.spyOn(auth, "sessionMethod").mockResolvedValue(outcome);
    const send = vi.spyOn(messageService, "sendChatMessage").mockResolvedValue({
      status: 200, body: { role: "assistant", answer: { segments: [{ text: "Shared answer", sourceIds: [] }], sources: [] } },
    });
    const response = await createApp().request("/api/trpc/chat.send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Question" }], courseId: 7, shareSlug: "shared" }),
    }, ENV);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { data: { code } } });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows shared chat when credentials are absent", async () => {
    vi.spyOn(auth, "sessionMethod").mockResolvedValue({ kind: "absent" });
    const send = vi.spyOn(messageService, "sendChatMessage").mockResolvedValue({
      status: 200, body: { role: "assistant", answer: { segments: [{ text: "Shared answer", sourceIds: [] }], sources: [] } },
    });
    const response = await createApp().request("/api/trpc/chat.send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Question" }], courseId: 7, shareSlug: "shared" }),
    }, ENV);
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(ENV, expect.objectContaining({ userId: null, shareSlug: "shared", visitorSessionId: expect.any(String) }));
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it.each([
    { result: { badRequest: "Monthly upload allowance exceeded", code: "MONTHLY_UPLOAD_LIMIT_EXCEEDED" }, status: 400,
      data: { applicationCode: "MONTHLY_UPLOAD_LIMIT_EXCEEDED" } },
    { result: { badRequest: "Storage limit exceeded", code: "STORAGE_LIMIT_EXCEEDED" }, status: 400,
      data: { applicationCode: "STORAGE_LIMIT_EXCEEDED" } },
    { result: { fieldError: { filename: ["Unsupported file type"] } }, status: 400,
      data: { applicationCode: "VALIDATION_ERROR", details: { filename: ["Unsupported file type"] } } },
  ])("preserves upload error metadata: $data.applicationCode", async ({ result, status, data }) => {
    videoService.requestPresignedUpload.mockResolvedValue(result);
    const response = await createApp().request("/api/trpc/videos.requestUpload", {
      method: "POST",
      headers: { ...testAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ filename: "clip.mp4", contentType: "video/mp4", fileSize: 1024, title: "Clip" }),
    }, ENV);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { data } });
  });

  it("logs a service exception with request and procedure context without request secrets", async () => {
    const privateValue = "private-user@example.test";
    const cause = Object.assign(new Error(`Key (email)=(${privateValue}) already exists`), {
      code: "23505", constraint: "users_email_key",
    });
    const error = Object.assign(new Error(`Failed query with parameters:\n    at ${privateValue}`, { cause }), {
      params: [privateValue], details: `Internal database detail: ${privateValue}`,
    });
    tagService.listTags.mockRejectedValueOnce(error);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await createApp().request(
      `/api/trpc/tags.list?secret=${privateValue}`,
      { headers: { ...testAuthHeaders(), "x-request-id": "trpc-error-test", cookie: "session=private-cookie" } },
      ENV,
    );

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: { message: "An internal server error occurred." } });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toContain('"params"');
    expect(serialized).not.toContain('"details"');
    expect(serialized).not.toContain('"stack"');
    expect(serialized).not.toContain("23505");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const logged = errorLog.mock.calls[0][0] as string;
    expect(JSON.parse(logged)).toMatchObject({
      level: "error", requestId: "trpc-error-test", path: "/api/trpc/tags.list",
      procedure: "tags.list", type: "query", code: "INTERNAL_SERVER_ERROR",
      error: { name: "Error", pgCode: "23505", constraint: "users_email_key" },
      stack: expect.stringContaining("at "),
    });
    expect(logged).not.toContain(privateValue);
    expect(logged).not.toContain("private-cookie");
    expect(logged).not.toContain("Failed query");
  });

  it("does not log validation failures as internal exceptions", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await createApp().request("/api/trpc/tags.create", {
      method: "POST", headers: { ...testAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    }, ENV);
    expect(response.status).toBe(400);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it.each(["tags.create", "tags.update"])("returns a name conflict without an internal error for %s", async procedure => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = procedure === "tags.create" ? tagService.createUserTag : tagService.updateUserTag;
    service.mockRejectedValueOnce(apiConflict("A tag with this name already exists."));
    const response = await createApp().request(`/api/trpc/${procedure}`, {
      method: "POST", headers: { ...testAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ id: 3, name: "Lecture", color: "blue" }),
    }, ENV);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: {
      message: "A tag with this name already exists.",
      data: { code: "CONFLICT", applicationCode: "CONFLICT" },
    } });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("preserves explicit application codes when masking a service failure", async () => {
    tagService.listTags.mockRejectedValueOnce(apiServiceUnavailable("private upstream detail", "SERVICE_UNAVAILABLE"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await createApp().request("/api/trpc/tags.list", { headers: testAuthHeaders() }, ENV);
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: { data: { applicationCode: "SERVICE_UNAVAILABLE" } } });
    expect(JSON.stringify(payload)).not.toContain("private upstream detail");
  });

  it.each(["tags.create", "tags.update"])(
    "rejects colors outside the shared palette before calling the service: %s",
    async (procedure) => {
      for (const color of ["not-a-color", "#3b82f6", ""]) {
        const response = await createApp().request(`/api/trpc/${procedure}`, {
          method: "POST",
          headers: { ...testAuthHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ id: 3, name: "Lecture", color }),
        }, ENV);

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { data: {
            code: "BAD_REQUEST",
            applicationCode: "VALIDATION_ERROR",
            details: { color: [expect.any(String)] },
          } },
        });
      }
      expect(tagService.createUserTag).not.toHaveBeenCalled();
      expect(tagService.updateUserTag).not.toHaveBeenCalled();
    },
  );

  it.each(TAG_COLORS)("accepts the shared palette color %s", async (color) => {
    tagService.createUserTag.mockResolvedValue({ tag: { ...sampleTag, color } });
    const response = await createApp().request("/api/trpc/tags.create", {
      method: "POST",
      headers: { ...testAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ name: "Lecture", color }),
    }, ENV);

    expect(response.status).toBe(200);
    expect(tagService.createUserTag).toHaveBeenCalledWith(ENV, TEST_USER_ID, "Lecture", color);
  });

  it("allows a name-only update of a tag with a legacy hex color", async () => {
    const tag = { ...sampleTag, name: "Updated", color: "#3b82f6" };
    tagService.updateUserTag.mockResolvedValue({ tag });
    const response = await createApp().request("/api/trpc/tags.update", {
      method: "POST",
      headers: { ...testAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ id: tag.id, name: tag.name }),
    }, ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: tag } });
    expect(tagService.updateUserTag).toHaveBeenCalledWith(ENV, tag.id, TEST_USER_ID, {
      name: tag.name, color: undefined,
    });
  });

  it("returns only declared output fields, including in nested lists", async () => {
    tagService.listTags.mockResolvedValue({
      count: 1,
      results: [{ ...sampleTag, internal_secret: "private-service-value" }],
    });
    const response = await createApp().request("/api/trpc/tags.list", {
      headers: testAuthHeaders(),
    }, ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: {
      data: [sampleTag],
      meta: { total: 1, limit: 100, offset: 0 },
    } } });
  });

  it.each(["query", "mutation"])(
    "reports malformed %s outputs as internal errors without exposing validation details",
    async (kind) => {
      const privateValue = "private-user@example.test";
      const invalidTag = { ...sampleTag, video_count: privateValue };
      tagService.listTags.mockResolvedValue({ count: 1, results: [invalidTag] });
      tagService.createUserTag.mockResolvedValue({ tag: invalidTag });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const response = await createApp().request(
        `/api/trpc/${kind === "query" ? "tags.list" : "tags.create"}`,
        kind === "query"
          ? { headers: testAuthHeaders() }
          : {
              method: "POST",
              headers: { ...testAuthHeaders(), "content-type": "application/json" },
              body: JSON.stringify({ name: "Lecture" }),
            },
        ENV,
      );

      expect(response.status).toBe(500);
      const payload = await response.json();
      expect(payload).toMatchObject({ error: {
        message: "An internal server error occurred.",
        data: { code: "INTERNAL_SERVER_ERROR" },
      } });
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("VALIDATION_ERROR");
      expect(serialized).not.toContain('"details"');
      expect(serialized).not.toContain("video_count");
      expect(serialized).not.toContain(privateValue);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateValue);
    },
  );

  it("serves a typed tag query through /api/trpc", async () => {
    tagService.listTags.mockResolvedValue({
      count: 1,
      results: [sampleTag],
    });
    const input = encodeURIComponent(JSON.stringify({ limit: 25, offset: 5 }));

    const response = await createApp().request(
      `/api/trpc/tags.list?input=${input}`,
      { headers: testAuthHeaders() },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        data: {
          data: [sampleTag],
          meta: { total: 1, limit: 25, offset: 5 },
        },
      },
    });
    expect(tagService.listTags).toHaveBeenCalledWith(
      ENV,
      TEST_USER_ID,
      25,
      5,
    );
  });

  it("serves a typed tag mutation and applies schema defaults", async () => {
    tagService.createUserTag.mockResolvedValue({ tag: sampleTag });

    const response = await createApp().request(
      "/api/trpc/tags.create",
      {
        method: "POST",
        headers: {
          ...testAuthHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Lecture" }),
      },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: sampleTag } });
    expect(tagService.createUserTag).toHaveBeenCalledWith(
      ENV,
      TEST_USER_ID,
      "Lecture",
      "gray",
    );
  });

  it("routes tag updates through the shared procedure contract", async () => {
    const updatedTag = { ...sampleTag, name: "Updated", color: "green" };
    tagService.updateUserTag.mockResolvedValue({ tag: updatedTag });

    const response = await createApp().request(
      "/api/trpc/tags.update",
      {
        method: "POST",
        headers: {
          ...testAuthHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: 3, name: "Updated", color: "green" }),
      },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: updatedTag } });
    expect(tagService.updateUserTag).toHaveBeenCalledWith(
      ENV,
      3,
      TEST_USER_ID,
      { name: "Updated", color: "green" },
    );
  });

  it("routes tag deletion and returns success", async () => {
    tagService.removeTag.mockResolvedValue({ ok: true });

    const response = await createApp().request(
      "/api/trpc/tags.delete",
      {
        method: "POST",
        headers: {
          ...testAuthHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: 3 }),
      },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: { success: true } } });
    expect(tagService.removeTag).toHaveBeenCalledWith(ENV, 3, TEST_USER_ID);
  });

  it("serves cursor-paginated courses through the shared router", async () => {
    courseService.listCourses.mockResolvedValue({
      count: 9,
      results: [sampleCourse],
    });
    const input = encodeURIComponent(JSON.stringify({ limit: 24, cursor: 5 }));

    const response = await createApp().request(
      `/api/trpc/courses.list?input=${input}`,
      { headers: testAuthHeaders() },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        data: {
          data: [sampleCourse],
          meta: { total: 9, limit: 24, offset: 5 },
        },
      },
    });
    expect(courseService.listCourses).toHaveBeenCalledWith(
      ENV,
      TEST_USER_ID,
      24,
      5,
    );
  });

  it("creates and reorders courses through typed mutations", async () => {
    courseService.createUserCourse.mockResolvedValue(sampleCourse);
    courseService.reorderUserCourses.mockResolvedValue({ ok: true });

    const createResponse = await createApp().request(
      "/api/trpc/courses.create",
      {
        method: "POST",
        headers: {
          ...testAuthHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: sampleCourse.name,
          description: sampleCourse.description,
        }),
      },
      ENV,
    );
    const reorderResponse = await createApp().request(
      "/api/trpc/courses.reorder",
      {
        method: "POST",
        headers: {
          ...testAuthHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ courseIds: [7, 8] }),
      },
      ENV,
    );

    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual({
      result: { data: sampleCourse },
    });
    expect(courseService.createUserCourse).toHaveBeenCalledWith(
      ENV,
      TEST_USER_ID,
      sampleCourse.name,
      sampleCourse.description,
    );
    expect(reorderResponse.status).toBe(200);
    expect(await reorderResponse.json()).toEqual({
      result: { data: { courseIds: [7, 8] } },
    });
    expect(courseService.reorderUserCourses).toHaveBeenCalledWith(
      ENV,
      TEST_USER_ID,
      [7, 8],
    );
  });

  it("serves video status counts through tRPC", async () => {
    videoService.getUserVideoStats.mockResolvedValue(sampleVideoStats);

    const response = await createApp().request(
      "/api/trpc/videos.statusCounts",
      { headers: testAuthHeaders() },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { data: sampleVideoStats },
    });
    expect(videoService.getUserVideoStats).toHaveBeenCalledWith(
      ENV,
      TEST_USER_ID,
    );
  });

});
