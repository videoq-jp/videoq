import { requestBodyText } from "./helpers/request-body";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { APIError } from "better-auth/api";
import { requestTrpc, trpcData } from "./helpers/trpc";

import {
  executeFakePgQuery,
  type PgQueryInput,
  type QueryCall,
  type MatchableSql,
} from "./helpers/pg-fake";

const nativeAdmin = vi.hoisted(() => ({
  banUser: vi.fn(), unbanUser: vi.fn(), setRole: vi.fn(),
}));
vi.mock("../src/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/auth")>(),
  createAuth: () => ({ api: nativeAdmin }),
}));

const calls: QueryCall[] = [];
let rowsFor: (sql: MatchableSql, args: unknown[]) => Record<string, unknown>[];

vi.mock("pg", () => {
  class FakeClient {
    async connect() {}
    async end() {}
    async query(sqlOrConfig: unknown, args: unknown[] = []) {
      return executeFakePgQuery({
        calls,
        sqlOrConfig: sqlOrConfig as PgQueryInput,
        args,
        rowsFor,
      });
    }
  }
  return { default: { Client: FakeClient } };
});

const enqueueAll = vi.fn();
vi.mock("../src/lib/jobs", () => ({
  enqueueReindexAllEmbeddings: (...a: unknown[]) => enqueueAll(...a),
}));
const processExternalTask = vi.fn();
vi.mock("../src/lib/external-tasks", () => ({
  processExternalTaskById: (...a: unknown[]) => processExternalTask(...a),
}));

const SECRET = "test-jwt-secret-admin";
const ENV = {
  ENVIRONMENT: "development",
  AUTH_JWT_SECRET: SECRET,
  BETTER_AUTH_SECRET: SECRET,
  HYPERDRIVE: { connectionString: "postgres://fake/db" },
} as unknown as Record<string, unknown>;

beforeEach(() => {
  calls.length = 0;
  for (const method of Object.values(nativeAdmin)) method.mockReset().mockResolvedValue({});
  enqueueAll.mockReset().mockResolvedValue("job-abc");
  processExternalTask.mockReset().mockResolvedValue(true);
  rowsFor = (sql) => {
    if (sql.includes("SELECT role FROM users")) return [{ role: "admin" }];
    if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) return [{ is_admin: false }];
    if (sql.includes("count(*)")) return [{ c: 1 }];
    if (sql.includes("external_tasks") && sql.includes("RETURNING")) {
      return [{ id: 73 }];
    }
    if (sql.includes("FROM users") || sql.includes("RETURNING id")) {
      return [
        {
          id: "00000000-0000-4000-8000-000000000009",
          username: "alice",
          email: "a@example.com",
          is_active: true,
          is_admin: false,
          max_video_upload_size_mb: 500,
          storage_limit_gb: 10, monthly_upload_limit_gb: 20,
          processing_limit_minutes: 60,
          ai_answers_limit: 100,
          used_storage_bytes: 0,
          used_processing_seconds: 0,
          used_ai_answers: 0,
          usage_period_start: null,
          is_over_quota: false,
        },
      ];
    }
    return [];
  };
});

const req = (path: string, init: RequestInit = {}) => {
  const url = new URL(path, "http://localhost");
  const body = init.body ? JSON.parse(requestBodyText(init.body)) as Record<string, unknown> : {};
  const headers = { headers: init.headers };
  if (url.pathname === "/users" && (init.method ?? "GET") === "GET") {
    return requestTrpc("admin.listUsers", "query", {
      q: url.searchParams.get("q") ?? undefined,
      limit: 100,
      offset: 0,
    }, headers, ENV);
  }
  if (url.pathname === "/embeddings/reindex-all") {
    return requestTrpc("admin.reindexAll", "mutation", undefined, headers, ENV);
  }
  const match = url.pathname.match(/^\/users\/([^/]+)(?:\/(quota|usage|flags))?$/);
  if (!match) throw new Error(`Unmapped admin test path: ${path}`);
  const [, id, action] = match;
  if (action === "quota") {
    return requestTrpc("admin.patchQuota", "mutation", { id, ...body }, headers, ENV);
  }
  if (action === "usage") {
    return requestTrpc("admin.patchUsage", "mutation", { id, ...body }, headers, ENV);
  }
  if (action === "flags") {
    return requestTrpc("admin.patchFlags", "mutation", { id, ...body }, headers, ENV);
  }
  return requestTrpc("admin.deleteUser", "mutation", { id }, headers, ENV);
};

describe("admin API", () => {
  it("非 admin は 403", async () => {
    rowsFor = (sql) => {
      if (sql.includes("SELECT role FROM users")) return [{ role: "user" }];
      return [];
    };
    const res = await req("/users", {
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(403);
  });

  it("一覧は 200", async () => {
    const res = await req("/users?q=ali", {
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(200);
    const body = await trpcData<{ meta: { total: number }; data: { id: string }[] }>(res);
    expect(body.meta.total).toBe(1);
    expect(body.data[0].id).toBe("00000000-0000-4000-8000-000000000009");
  });

  it("quota PATCH", async () => {
    const res = await req("/users/00000000-0000-4000-8000-000000000009/quota", {
      method: "PATCH",
      headers: {
        "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001",
        "content-type": "application/json",
      },
      body: JSON.stringify({ storage_limit_gb: 50 }),
    });
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.sql.includes("UPDATE users"))).toBe(true);
  });

  it.each([
    ["quota", "monthly_upload_limit_gb", -1],
    ["quota", "storage_limit_gb", -0.5],
    ["quota", "processing_limit_minutes", -1],
    ["quota", "processing_limit_minutes", 1.5],
    ["quota", "processing_limit_minutes", 2_147_483_648],
    ["quota", "ai_answers_limit", -1],
    ["quota", "ai_answers_limit", 1.5],
    ["quota", "ai_answers_limit", 2_147_483_648],
    ["usage", "used_processing_seconds", 2_147_483_648],
    ["usage", "used_ai_answers", 2_147_483_648],
    ["usage", "used_storage_bytes", Number.MAX_SAFE_INTEGER + 1],
    ["usage", "usage_period_start", "not-a-date"],
    ["usage", "usage_period_start", "2026-02-30T00:00:00Z"],
    ["usage", "usage_period_start", "2026-09-28T00:00:00"],
  ])("rejects invalid %s.%s=%s before writing", async (section, field, value) => {
    const response = await req(`/users/00000000-0000-4000-8000-000000000009/${section}`, {
      method: "PATCH",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
      body: JSON.stringify({ [field]: value }),
    });
    expect(response.status).toBe(400);
    expect(calls.some(call => call.sql.includes("UPDATE users"))).toBe(false);
  });

  it.each([
    ["quota", { max_video_upload_size_mb: 2_147_483_647, storage_limit_gb: 0.5,
      processing_limit_minutes: 0, ai_answers_limit: 2_147_483_647 }],
    ["quota", { storage_limit_gb: 0, processing_limit_minutes: 2_147_483_647, ai_answers_limit: 0 }],
    ["quota", { storage_limit_gb: null, monthly_upload_limit_gb: null, processing_limit_minutes: null, ai_answers_limit: null }],
    ["usage", { used_storage_bytes: Number.MAX_SAFE_INTEGER, used_processing_seconds: 2_147_483_647,
      used_ai_answers: 2_147_483_647, usage_period_start: "2026-09-28T09:30:00+09:00" }],
    ["usage", { used_storage_bytes: 0, used_processing_seconds: 0, used_ai_answers: 0, usage_period_start: null }],
  ])("accepts valid %s boundaries without changing values", async (section, patch) => {
    const response = await req(`/users/00000000-0000-4000-8000-000000000009/${section}`, {
      method: "PATCH",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
    const update = calls.find(call => call.sql.includes("UPDATE users"));
    expect(update).toBeDefined();
    expect(update!.args).toEqual(expect.arrayContaining(Object.values(patch)));
  });

  it("flags PATCH", async () => {
    const res = await req("/users/00000000-0000-4000-8000-000000000009/flags", {
      method: "PATCH",
      headers: {
        "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001",
        "content-type": "application/json",
      },
      body: JSON.stringify({ is_admin: true }),
    });
    expect(res.status).toBe(200);
    expect(nativeAdmin.setRole).toHaveBeenCalledWith(expect.objectContaining({
      body: { userId: "00000000-0000-4000-8000-000000000009", role: "admin" },
      headers: expect.any(Headers),
    }));
  });

  it.each(["is_staff", "is_superuser"])("rejects the retired %s flag", async (flag) => {
    const res = await req("/users/00000000-0000-4000-8000-000000000009/flags", {
      method: "PATCH",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
      body: JSON.stringify({ [flag]: true }),
    });
    expect(res.status).toBe(400);
    expect(nativeAdmin.setRole).not.toHaveBeenCalled();
  });

  it("自分の admin フラグは外せない", async () => {
    rowsFor = (sql) => {
      if (sql.includes("SELECT role FROM users")) return [{ role: "admin" }];
      if (sql.includes("FROM users")) {
        return [
          {
            id: "00000000-0000-4000-8000-000000000001",
            username: "admin",
            email: "admin@example.com",
            is_active: true,
            is_admin: true,
            max_video_upload_size_mb: 500,
            storage_limit_gb: null, monthly_upload_limit_gb: null,
            processing_limit_minutes: null,
            ai_answers_limit: null,
            used_storage_bytes: 0,
            used_processing_seconds: 0,
            used_ai_answers: 0,
            usage_period_start: null,
            is_over_quota: false,
          },
        ];
      }
      return [];
    };
    const res = await req("/users/00000000-0000-4000-8000-000000000001/flags", {
      method: "PATCH",
      headers: {
        "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001",
        "content-type": "application/json",
      },
      body: JSON.stringify({ is_admin: false }),
    });
    expect(res.status).toBe(400);
  });

  it("reindex-all は 202 + job_id", async () => {
    const res = await req("/embeddings/reindex-all", {
      method: "POST",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(200);
    expect(await trpcData(res)).toEqual({ job_id: "job-abc" });
    expect(enqueueAll).toHaveBeenCalled();
  });

  it("ユーザー削除は 202 でジョブを投入する", async () => {
    const res = await req("/users/00000000-0000-4000-8000-000000000009", {
      method: "DELETE",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(200);
    const body = await trpcData<{ job_id: string }>(res);
    expect(body.job_id).toMatch(/[0-9a-f-]{36}/);
    expect(processExternalTask).toHaveBeenCalledWith(ENV, 73);
    expect(calls.some((c) => c.sql.includes("UPDATE") && c.sql.includes("users"))).toBe(
      true,
    );
    expect(calls.some((c) => c.sql.includes("DELETE") && c.sql.includes("session"))).toBe(
      true,
    );
    expect(
      calls.some((c) => c.sql.includes("DELETE") && c.sql.includes("oauth_access_token")),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          (c.sql.includes("UPDATE") || c.sql.includes("DELETE")) &&
          c.sql.includes("oauth_refresh_token"),
      ),
    ).toBe(true);
  });

  it.each([false, true])("is_active=%s uses the official Admin API", async (is_active) => {
    const res = await req("/users/00000000-0000-4000-8000-000000000009/flags", {
      method: "PATCH",
      headers: {
        "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001",
        cookie: "forwarded-session-cookie",
        "content-type": "application/json",
      },
      body: JSON.stringify({ is_active }),
    });
    expect(res.status).toBe(200);
    const method = is_active ? nativeAdmin.unbanUser : nativeAdmin.banUser;
    expect(method).toHaveBeenCalledWith({
      body: { userId: "00000000-0000-4000-8000-000000000009" }, headers: expect.any(Headers),
    });
    expect(method.mock.calls[0][0].headers.get("cookie")).toBe("forwarded-session-cookie");
  });

  it("denies administration after native role removal", async () => {
    rowsFor = (sql) => sql.includes("SELECT role FROM users") ? [{ role: "user" }] : [];
    expect((await req("/users", { headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" } })).status).toBe(403);
  });

  it("returns native authorization failures and rolls back the flag transaction", async () => {
    nativeAdmin.banUser.mockRejectedValueOnce(new APIError("FORBIDDEN", { message: "Permission denied" }));
    const response = await req("/users/00000000-0000-4000-8000-000000000009/flags", {
      method: "PATCH", headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
      body: JSON.stringify({ is_active: false, is_admin: true }),
    });
    expect(response.status).toBe(403);
    expect(nativeAdmin.setRole).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("ROLLBACK"))).toBe(true);
  });

  it("永続化済みの削除ジョブを返し、リクエスト内では削除しない", async () => {
    const res = await req("/users/00000000-0000-4000-8000-000000000009", {
      method: "DELETE",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(200);
    const body = await trpcData<{ job_id: string }>(res);
    expect(body.job_id).toMatch(/[0-9a-f-]{36}/);
    expect(
      calls.some(
        (c) => c.sql.includes("DELETE") && c.sql.includes("scene_embeddings"),
      ),
    ).toBe(false);
    expect(
      calls.some((c) => c.sql.includes("DELETE") && c.sql.includes("users")),
    ).toBe(false);
  });

  it("自分自身は削除できない", async () => {
    rowsFor = (sql) => {
      if (sql.includes("SELECT role FROM users")) return [{ role: "admin" }];
      if (sql.includes("FROM users")) {
        return [
          {
            id: "00000000-0000-4000-8000-000000000001",
            username: "admin",
            email: "admin@example.com",
            is_active: true,
            is_admin: true,
            max_video_upload_size_mb: 500,
            storage_limit_gb: null, monthly_upload_limit_gb: null,
            processing_limit_minutes: null,
            ai_answers_limit: null,
            used_storage_bytes: 0,
            used_processing_seconds: 0,
            used_ai_answers: 0,
            usage_period_start: null,
            is_over_quota: false,
          },
        ];
      }
      return [];
    };
    const res = await req("/users/00000000-0000-4000-8000-000000000001", {
      method: "DELETE",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(400);
    expect(processExternalTask).not.toHaveBeenCalled();
  });

  it("他 admin は削除できない", async () => {
    rowsFor = (sql) => {
      if (sql.includes("SELECT role FROM users")) return [{ role: "admin" }];
      if (sql.includes("FROM users") && sql.includes("FOR UPDATE")) return [{ is_admin: true }];
      if (sql.includes("FROM users")) {
        return [
          {
            id: "00000000-0000-4000-8000-000000000009",
            username: "other-admin",
            email: "other@example.com",
            is_active: true,
            is_admin: true,
            max_video_upload_size_mb: 500,
            storage_limit_gb: null, monthly_upload_limit_gb: null,
            processing_limit_minutes: null,
            ai_answers_limit: null,
            used_storage_bytes: 0,
            used_processing_seconds: 0,
            used_ai_answers: 0,
            usage_period_start: null,
            is_over_quota: false,
          },
        ];
      }
      return [];
    };
    const res = await req("/users/00000000-0000-4000-8000-000000000009", {
      method: "DELETE",
      headers: { "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(res.status).toBe(403);
    expect(processExternalTask).not.toHaveBeenCalled();
  });
});
