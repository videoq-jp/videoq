import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { videoRoutes } from "../src/features/videos/routes";
import { testAuthHeaders } from "./helpers/auth";
import { requestTrpc, trpcError } from "./helpers/trpc";

import {
  matchableSql,
  normalizePgQuery,
  type MatchableSql,
  type PgQueryInput,
} from "./helpers/pg-fake";

const putMock = vi.fn();
const queryMock = vi.fn();

vi.mock("pg", () => {
  class FakeClient {
    async connect() {}
    async end() {}
    async query(sqlOrConfig: unknown, args: unknown[] = []) {
      const { sql, args: a, rowMode } = normalizePgQuery(
        sqlOrConfig as PgQueryInput,
        args,
      );
      const matchSql = matchableSql(sql);
      const result = queryMock(matchSql, a);
      if (rowMode === "array" && result.rows?.length) {
        return {
          ...result,
          rows: result.rows.map((r: Record<string, unknown> | unknown[]) =>
            Array.isArray(r) ? r : Object.values(r),
          ),
        };
      }
      return result;
    }
  }
  return { default: { Client: FakeClient } };
});

vi.mock("../src/lib/external-tasks", () => ({
  processExternalTaskById: vi.fn().mockResolvedValue(true),
}));

const baseEnv = {
  ENVIRONMENT: "development",
  BETTER_AUTH_SECRET: "test-video-auth-secret-01234567890123456789",
  HYPERDRIVE: { connectionString: "postgres://fake/db" },
  VIDEO_BUCKET: {
    put: (...a: unknown[]) => putMock(...a),
    head: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
};

beforeEach(() => {
  putMock.mockReset().mockResolvedValue(undefined);
  queryMock.mockReset().mockImplementation((sql: MatchableSql) => {
    if (sql.includes("clock_timestamp()")) {
      return { rows: [{ periodStart: "2026-10-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("upload_usage_period_start") && sql.includes("update")) {
      return { rows: [{ periodStart: "2026-10-01T00:00:00Z" }], rowCount: 1 };
    }
    if (sql.includes("for update") && sql.includes("users")) {
      return { rows: [{ id: "owner" }], rowCount: 1 };
    }
    if (sql.includes("max_video_upload_size_mb")) {
      return { rows: [{ max_video_upload_size_mb: 500 }], rowCount: 1 };
    }
    if (sql.includes("storage_limit_gb") || sql.includes("is_over_quota")) {
      return { rows: [{ storage_limit_gb: null, is_over_quota: false }], rowCount: 1 };
    }
    if (sql.includes("used_storage_bytes")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("external_tasks") && sql.includes("returning")) {
      return { rows: [{ id: 9 }], rowCount: 1 };
    }
    if (sql.includes("videos") && sql.includes("returning")) {
      return { rows: [{ id: 42 }], rowCount: 1 };
    }
    if (sql.includes("videos") && sql.includes("select")) {
      return {
        rows: [
          {
            id: 42,
            user_id: "00000000-0000-4000-8000-000000000005",
            file: "videos/5/video_1_4.mp4",
            title: "Clip",
            description: "",
            uploaded_at: "2026-01-01T00:00:00.000000-06:00",
            transcript: "",
            status: "pending",
            source_type: "uploaded",
            source_url: "",
            youtube_video_id: "",
            error_message: "",
            tags: "[]",
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST / — USE_S3_STORAGE=true（廃線）", () => {
  const ENV = { ...baseEnv, USE_S3_STORAGE: "true" } as unknown as Record<string, unknown>;

  it("本文を解析せず 400 で署名 URL 経路を案内する", async () => {
    const body = new FormData();
    body.append("file", new File(["unused"], "unused.mp4", { type: "video/mp4" }));
    const formDataSpy = vi.spyOn(Request.prototype, "formData");
    const res = await videoRoutes.request(
      "/",
      {
        method: "POST",
        headers: {
          "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000005",
        },
        body,
      },
      ENV,
    );
    expect(res.status).toBe(400);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Direct multipart upload is unavailable in object-storage mode. Call the videos.requestUpload tRPC procedure, PUT the file to upload_url, then call videos.confirmUpload.",
      },
    });
  });
});

describe("POST / — USE_S3_STORAGE=false（multipart）", () => {
  const ENV = { ...baseEnv, USE_S3_STORAGE: "false" } as unknown as Record<string, unknown>;

  it("未認証は 401", async () => {
    const res = await videoRoutes.request(
      "/",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ENV,
    );
    expect(res.status).toBe(401);
  });

  it("multipart で VIDEO_BUCKET に保存して 201", async () => {
    const form = new FormData();
    form.append("file", new File(["abcd"], "clip.mp4", { type: "video/mp4" }));
    form.append("title", "Clip");
    form.append("description", "");

    const res = await videoRoutes.request(
      "/",
      {
        method: "POST",
        headers: testAuthHeaders(),
        body: form,
      },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(putMock).toHaveBeenCalled();
    const key = putMock.mock.calls[0][0] as string;
    expect(key).toMatch(
      /^media\/videos\/00000000-0000-4000-8000-000000000005\/video_\d+_[0-9a-f]{12}_\d+\.mp4$/,
    );
    const body = (await res.json<{ id: number; status: string }>());
    expect(body.id).toBe(42);
    expect(body.status).toBe("pending");
  });
});

describe("videos.requestUpload — local では不可", () => {
  it("USE_S3_STORAGE=false は 400", async () => {
    const ENV = { ...baseEnv, USE_S3_STORAGE: "false" } as unknown as Record<string, unknown>;
    const res = await requestTrpc(
      "videos.requestUpload",
      "mutation",
      {
        filename: "a.mp4",
        contentType: "video/mp4",
        fileSize: 10,
        title: "t",
      },
      { headers: testAuthHeaders() },
      ENV,
    );
    expect(res.status).toBe(400);
    expect(await trpcError(res)).toMatchObject({
      message: "Presigned upload URLs are unavailable when USE_S3_STORAGE=False.",
    });
  });
});
