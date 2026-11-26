import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { TEST_USER_ID, testAuthHeaders } from "./helpers/auth";
import { requestTrpc, trpcData } from "./helpers/trpc";
import * as courseService from "../src/integrations/courses";
import * as videoService from "../src/features/videos/service";

const ENV = {
  ENVIRONMENT: "test",
  CORS_ALLOW_ORIGIN: "http://localhost:5173",
} as unknown as Parameters<ReturnType<typeof createApp>["request"]>[2];

vi.mock("../src/integrations/courses", async () => {
  const { createUseCaseBus } = await import('../src/application/use-case-bus');
  const methods = {
    listCourses: vi.fn(async () => ({ count: 0, results: [] })),
    reorderUserCourses: vi.fn(async () => ({ ok: true })),
  };
  return { ...methods, createCourseUseCases: async () => createUseCaseBus(methods) };
});

vi.mock("../src/features/videos/service", () => ({
  getUserVideoStats: vi.fn(async () => ({
    total: 24,
    completed: 24,
    pending: 0,
    processing: 0,
    indexing: 0,
    error: 0,
    uploading: 0,
  })),
}));

describe("video/course JSON endpoints use tRPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["GET", "/api/videos/courses"],
    ["PATCH", "/api/videos/courses/order"],
    ["GET", "/api/videos/stats"],
  ])("removes the legacy %s %s route", async (method, path) => {
    const response = await createApp().request(
      path,
      { method, headers: testAuthHeaders() },
      ENV,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("lists courses through courses.list", async () => {
    const response = await requestTrpc(
      "courses.list",
      "query",
      { limit: 100, cursor: 0 },
      { headers: testAuthHeaders() },
      ENV,
    );
    expect(response.status).toBe(200);
    expect(await trpcData(response)).toEqual({
      data: [],
      meta: { total: 0, limit: 100, offset: 0 },
    });
    expect(courseService.listCourses).toHaveBeenCalledWith(TEST_USER_ID, 100, 0);
  });

  it("reorders courses through courses.reorder", async () => {
    const response = await requestTrpc(
      "courses.reorder",
      "mutation",
      { courseIds: [2, 1] },
      { headers: testAuthHeaders() },
      ENV,
    );
    expect(response.status).toBe(200);
    expect(await trpcData(response)).toEqual({ courseIds: [2, 1] });
    expect(courseService.reorderUserCourses).toHaveBeenCalledWith(TEST_USER_ID, [2, 1]);
  });

  it("loads video status counts through videos.statusCounts", async () => {
    const response = await requestTrpc(
      "videos.statusCounts",
      "query",
      undefined,
      { headers: testAuthHeaders() },
      ENV,
    );
    expect(response.status).toBe(200);
    expect(await trpcData(response)).toEqual({
      total: 24,
      completed: 24,
      pending: 0,
      processing: 0,
      indexing: 0,
      error: 0,
      uploading: 0,
    });
    expect(videoService.getUserVideoStats).toHaveBeenCalledWith(ENV, TEST_USER_ID);
  });
});
