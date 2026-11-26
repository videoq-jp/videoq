import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp } from "../src/app";
import { mcpRoutes } from "../src/features/mcp/routes";
import { setRateLimitBackendForTests } from "../src/lib/rate-limit";
import { MANAGEMENT_WRITE_TOOLS } from "../src/tools/management";

import {
  executeFakePgQuery,
  type PgQueryInput,
  type QueryCall,
  type MatchableSql,
} from "./helpers/pg-fake";

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

const ENV = {
  ENVIRONMENT: "development",
  AUTH_JWT_SECRET: "unused-for-mcp-api-key",
  OAUTH_ISSUER_URL: "https://api.example.com",
  HYPERDRIVE: { connectionString: "postgres://fake/db" },
} as unknown as Record<string, unknown>;

const RAW_KEY = "vq_mcp_test_key_value_xxxxxx";

const apiKeyRow = (accessLevel = "all") => [
  { api_key_id: 1, user_id: "00000000-0000-4000-8000-000000000005", access_level: accessLevel },
];

beforeEach(() => {
  calls.length = 0;
  rowsFor = (sql) => {
    if (sql.includes("UPDATE api_keys")) return apiKeyRow();
    return [];
  };
});
afterEach(() => vi.unstubAllGlobals());

const initializeParams = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "videoq-mcp-test", version: "0.0.0" },
};

const jsonrpc = (method: string, params?: unknown, id: number | null = 1) => {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== null) body.id = id;
  if (params !== undefined) body.params = params;
  return body;
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  mcpRoutes.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": RAW_KEY,
        "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000005",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    ENV,
  );

describe("MCP auth", () => {
  it("rejects unauthenticated with WWW-Authenticate resource_metadata", async () => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(jsonrpc("initialize", initializeParams)),
      },
      ENV,
    );
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(challenge).not.toContain('scope="');
  });

  it("accepts X-API-Key", async () => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-api-key": RAW_KEY,
          "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000005",
          "X-VideoQ-Test-Access-Level": "all",
        },
        body: JSON.stringify(jsonrpc("initialize", initializeParams)),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("videoq-api");
  });

  it("accepts OAuth bearer via test oauth user header", async () => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer oauth-access-token-value",
          "X-VideoQ-Test-OAuth-User-Id": "00000000-0000-4000-8000-000000000009",
        },
        body: JSON.stringify(jsonrpc("ping")),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it.each([...MANAGEMENT_WRITE_TOOLS])("challenges for videoq.write before executing %s", async (name) => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer oauth-access-token-value",
          "X-VideoQ-Test-OAuth-User-Id":
            "00000000-0000-4000-8000-000000000009",
          "X-VideoQ-Test-OAuth-Scopes": "videoq.read",
        },
        body: JSON.stringify(
          jsonrpc("tools/call", {
            name,
            arguments: {
              idempotency_key: "course-physics-oauth-1",
              name: "Physics",
            },
          }),
        ),
      },
      ENV,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
    expect(res.headers.get("WWW-Authenticate")).toContain('scope="videoq.read videoq.write"');
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(calls).toHaveLength(0);
  });

  it("challenges before executing any part of a batch containing a write", async () => {
    const res = await post([
      jsonrpc("ping", undefined, 1),
      jsonrpc("tools/call", { name: "create_course", arguments: { name: "Physics" } }, 2),
    ], {
      authorization: "Bearer oauth-access-token-value",
      "X-VideoQ-Test-OAuth-User-Id": "00000000-0000-4000-8000-000000000009",
      "X-VideoQ-Test-OAuth-Scopes": "videoq.read",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toContain('scope="videoq.read videoq.write"');
    expect(calls).toHaveLength(0);
  });

  it("keeps read-only OAuth usable for discovery and reading requests", async () => {
    for (const method of ["ping", "tools/list"]) {
      const res = await post(jsonrpc(method), {
        authorization: "Bearer oauth-access-token-value",
        "X-VideoQ-Test-OAuth-User-Id": "00000000-0000-4000-8000-000000000009",
        "X-VideoQ-Test-OAuth-Scopes": "videoq.read",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
      expect(await res.json()).toHaveProperty("result");
    }
  });

  it("leaves malformed JSON errors to the MCP transport for read-only OAuth", async () => {
    const res = await mcpRoutes.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer oauth-access-token-value",
        "X-VideoQ-Test-OAuth-User-Id": "00000000-0000-4000-8000-000000000009",
        "X-VideoQ-Test-OAuth-Scopes": "videoq.read",
      },
      body: "{",
    }, ENV);
    expect(res.status).toBe(400);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("leaves invalid JSON-RPC envelopes to the SDK instead of requesting more permission", async () => {
    const res = await post({
      jsonrpc: "invalid", id: 1, method: "tools/call", params: { name: "create_course" },
    }, {
      authorization: "Bearer oauth-access-token-value",
      "X-VideoQ-Test-OAuth-User-Id": "00000000-0000-4000-8000-000000000009",
      "X-VideoQ-Test-OAuth-Scopes": "videoq.read",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns an insufficient_scope challenge when OAuth lacks videoq.read", async () => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer oauth-access-token-value",
          "X-VideoQ-Test-OAuth-User-Id":
            "00000000-0000-4000-8000-000000000009",
          "X-VideoQ-Test-OAuth-Scopes": "openid profile",
        },
        body: JSON.stringify(jsonrpc("ping")),
      },
      ENV,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(await res.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("accepts read_only API key for read tools", async () => {
    const res = await post(jsonrpc("initialize", initializeParams), {
      "X-VideoQ-Test-Access-Level": "read_only",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("videoq-api");
  });
});

describe("MCP JSON-RPC", () => {
  it("serves / without trailing slash (no redirect)", async () => {
    const res = await post(jsonrpc("initialize", initializeParams));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo).toEqual({
      name: "videoq-api",
      version: "0.3.0",
    });
  });

  it("validates and authorizes evidence tool calls through the authenticated HTTP transport", async () => {
    const window = { video_id: 42, start_seconds: 0, end_seconds: 5, context_seconds: 0 };
    const missingScope = await post(jsonrpc("tools/call", { name: "read_video_window", arguments: window }));
    expect((await missingScope.json()).result.isError).toBe(true);
    const denied = await post(jsonrpc("tools/call", { name: "read_video_window", arguments: { ...window, course_id: 3 } }));
    expect((await denied.json()).result.structuredContent).toMatchObject({ result: { status: "unavailable" } });
  });

  it("lists all tools", async () => {
    const res = await post(jsonrpc("tools/list"));
    const tools = (await res.json()).result.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names.sort()).toEqual(
      [
        "search_scenes", "read_video_window", "inspect_clip", "overview_video", "skim_video", "focus_clip", "get_course_info",
        "list_videos",
        "get_video",
        "request_video_upload",
        "confirm_video_upload",
        "create_youtube_video",
        "list_courses",
        "get_course",
        "create_course",
        "add_video_to_course",
        "list_tags",
        "get_chat_history",
        "get_chat_analytics",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.title, `${String(tool.name)} title`).toEqual(expect.any(String));
      expect(tool.description, `${String(tool.name)} description`).toEqual(
        expect.any(String),
      );
      expect(tool.inputSchema, `${String(tool.name)} inputSchema`).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema, `${String(tool.name)} outputSchema`).toMatchObject({
        type: "object",
      });
      expect(tool.annotations, `${String(tool.name)} annotations`).toEqual(
        expect.objectContaining({
          readOnlyHint: expect.any(Boolean),
          destructiveHint: expect.any(Boolean),
          idempotentHint: expect.any(Boolean),
          openWorldHint: expect.any(Boolean),
        }),
      );
    }
    expect(tools.find((tool) => tool.name === "list_videos")).toMatchObject({
      inputSchema: { properties: { limit: { anyOf: expect.arrayContaining([
        expect.objectContaining({ type: "integer", minimum: 1, maximum: 100 }),
        expect.objectContaining({ type: "string", pattern: "^[0-9]+$" }),
      ]) } } },
    });
    expect(
      tools.filter(
        (tool) =>
          (tool.annotations as { readOnlyHint?: boolean }).readOnlyHint === true,
      ),
    ).toHaveLength(14);
    expect(
      tools.filter(
        (tool) =>
          (tool.annotations as { readOnlyHint?: boolean }).readOnlyHint === false,
      ),
    ).toHaveLength(5);
    expect(tools.find((tool) => tool.name === "list_videos")).toMatchObject({
      title: "List videos",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: { type: "object" },
    });
    expect(tools.find((tool) => tool.name === "create_course")).toMatchObject({
      title: "Create course",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: { type: "object" },
    });

    const concreteOutputFields = [
      ["list_videos", ["properties", "videos", "items", "properties"], "id"],
      ["get_video", ["properties", "video", "properties"], "status"],
      ["request_video_upload", ["properties", "video", "properties"], "source_type"],
      ["confirm_video_upload", ["properties", "video", "properties"], "uploaded_at"],
      ["create_youtube_video", ["properties", "video", "properties"], "youtube_video_id"],
      ["list_courses", ["properties", "courses", "items", "properties"], "access_role"],
      ["get_course", ["properties", "course", "properties"], "videos"],
      ["create_course", ["properties", "course", "properties"], "name"],
      ["add_video_to_course", ["properties", "result", "properties"], "reused"],
      ["list_tags", ["properties", "tags", "items", "properties"], "video_count"],
      ["get_chat_history", ["properties", "history", "items", "properties"], "question"],
      ["get_chat_analytics", ["properties", "analytics", "properties"], "summary"],
    ] as const;
    for (const [name, path, field] of concreteOutputFields) {
      const tool = tools.find((candidate) => candidate.name === name);
      let current: unknown = tool?.outputSchema;
      for (const segment of path) {
        current = current && typeof current === "object"
          ? (current as Record<string, unknown>)[segment]
          : undefined;
      }
      expect(current, `${name} concrete output properties`).toBeTypeOf("object");
      expect(current, `${name} output field ${field}`).toHaveProperty(field);
    }
  });

  it("rejects write tools for a read_only API key", async () => {
    const res = await post(
      jsonrpc("tools/call", {
        name: "create_course",
        arguments: { name: "Physics", idempotency_key: "course-physics-1" },
      }),
      { "X-VideoQ-Test-Access-Level": "read_only" },
    );
    const result = (await res.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Write permission is required for this tool.");
    expect(result.structuredContent).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  it.each(["apikey", "oauth"])("allows course creation with write permission via %s", async (via) => {
    rowsFor = (sql) => {
      if (sql.includes("UPDATE api_keys")) return apiKeyRow();
      if (sql.includes('FROM "mcp_idempotency_records"')) return [];
      if (sql.includes("INSERT INTO video_courses")) {
        return [{ id: 7 }];
      }
      if (
        sql.includes('FROM "video_courses"') &&
        sql.includes("video_count")
      ) {
        return [
          {
            id: 7,
            name: "Physics",
            description: "Semester 1",
            display_order: 0,
            created_at: "2026-09-01T00:00:00.000Z",
            updated_at: "2026-09-01T00:00:00.000Z",
            share_slug: null,
            video_count: 0,
            owner_user_id: "00000000-0000-4000-8000-000000000005",
          },
        ];
      }
      return [];
    };
    const res = await post(
      jsonrpc("tools/call", {
        name: "create_course",
        arguments: {
          idempotency_key: "course-physics-success-1",
          name: "Physics",
          description: "Semester 1",
        },
      }),
      via === "oauth" ? {
        authorization: "Bearer oauth-access-token-value",
        "X-VideoQ-Test-OAuth-User-Id": "00000000-0000-4000-8000-000000000005",
        "X-VideoQ-Test-OAuth-Scopes": "videoq.read videoq.write",
      } : {},
    );
    expect(res.status).toBe(200);
    const result = (await res.json()).result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      course: { id: 7, name: "Physics", videos: [] },
      reused: false,
    });
  });

  it("tools/call list_videos returns empty envelope", async () => {
    rowsFor = (sql) => {
      if (sql.includes("UPDATE api_keys")) return apiKeyRow();
      if (sql.includes("count(*)") && sql.includes("videos")) {
        return [{ c: 0 }];
      }
      return [];
    };
    const res = await post(
      jsonrpc("tools/call", { name: "list_videos", arguments: {} }),
    );
    const result = (await res.json()).result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      meta: {
        total: 0,
        limit: 20,
        offset: 0,
        has_more: false,
        next_offset: null,
      },
      videos: [],
    });
  });

  it("tools/call get_video not found → isError", async () => {
    rowsFor = (sql) =>
      sql.includes("UPDATE api_keys") ? apiKeyRow() : [];
    const res = await post(
      jsonrpc("tools/call", {
        name: "get_video",
        arguments: { video_id: 404 },
      }),
    );
    const result = (await res.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Video not found");
    expect(result.structuredContent).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  it("tools/call coerces string video_id", async () => {
    rowsFor = (sql) =>
      sql.includes("UPDATE api_keys") ? apiKeyRow() : [];
    const res = await post(
      jsonrpc("tools/call", {
        name: "get_video",
        arguments: { video_id: "404" },
      }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Video not found");
  });

  it.each([
    ["get_video", { video_id: true }],
    ["add_video_to_course", { course_id: 7, video_id: [42] }],
    ["confirm_video_upload", { video_id: "0x2a" }],
    ["get_video", { video_id: 42, unexpected: true }],
  ])("rejects malformed %s arguments through the SDK before resource access", async (name, args) => {
    const res = await post(jsonrpc("tools/call", { name, arguments: args }));
    expect(res.status).toBe(200);
    const result = (await res.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid arguments/i);
    expect(calls).toHaveLength(0);
  });

  it("returns transcript metadata without content for a default get_video request", async () => {
    rowsFor = (sql) => {
      if (sql.includes("UPDATE api_keys")) return apiKeyRow();
      if (sql.includes('FROM "videos"')) {
        return [{
          id: 42, file: null, title: "Lecture", description: "",
          uploaded_at: "2026-09-01T00:00:00.000Z", status: "completed",
          source_type: "uploaded", source_url: "", youtube_video_id: "", tags: "[]",
          visual_processing: null,
          error_message: "", transcript_total_chars: 100_000,
        }];
      }
      return [];
    };

    const response = await post(jsonrpc("tools/call", { name: "get_video", arguments: { video_id: 42 } }));
    const result = (await response.json()).result;

    expect(result.isError).toBe(false);
    expect(result.structuredContent.video).toMatchObject({
      id: 42, transcript_available: true, transcript_total_chars: 100_000,
    });
    for (const field of ["transcript", "file", "user"]) {
      expect(result.structuredContent.video).not.toHaveProperty(field);
    }
  });

  it("returns only a bounded transcript chunk and omits signed file/user fields", async () => {
    rowsFor = (sql) => {
      if (sql.includes("UPDATE api_keys")) return apiKeyRow();
      if (sql.includes('FROM "videos"')) {
        return [
          {
            id: 42,
            user_id: "00000000-0000-4000-8000-000000000005",
            file: "videos/user/lecture.mp4",
            title: "Lecture",
            description: "",
            uploaded_at: "2026-09-01T00:00:00.000Z",
            transcript: "0123456789",
            status: "completed",
            source_type: "uploaded",
            source_url: "",
            youtube_video_id: "",
            error_message: "",
            tags: "[]",
          },
        ];
      }
      return [];
    };
    const res = await post(
      jsonrpc("tools/call", {
        name: "get_video",
        arguments: {
          video_id: 42,
          include_transcript: true,
          transcript_offset: 3,
          transcript_limit: 4,
        },
      }),
    );
    const video = (await res.json()).result.structuredContent.video;
    expect(video).not.toHaveProperty("file");
    expect(video).not.toHaveProperty("user");
    expect(video.transcript).toEqual({
      text: "3456",
      offset: 3,
      returned_chars: 4,
      total_chars: 10,
      has_more: true,
      next_offset: 7,
    });
  });

  it("returns a tool error when the per-user MCP rate limit is exhausted", async () => {
    setRateLimitBackendForTests({
      consume: async () => ({ allowed: false, retryAfterSec: 17 }),
      release: async () => {},
      snapshot: async () => null,
      record: async () => {},
    });
    const res = await post(
      jsonrpc("tools/call", { name: "list_videos", arguments: {} }),
    );
    const result = (await res.json()).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: 429,
      code: "RATE_LIMITED",
      retry_after_seconds: 17,
    });
  });

  it("GET with application/json-only Accept is normalized to open SSE", async () => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "GET",
        headers: {
          "x-api-key": RAW_KEY,
          "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000005",
          accept: "application/json",
        },
      },
      ENV,
    );
    // Accept 補完により 406 にせず SSE を開く（Claude Code / Cowork 互換）。
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    // ストリームを閉じる（テストがハングしないように）。
    await res.body?.cancel();
  });

  it("POST with non-MCP Accept is normalized and still serves JSON-RPC", async () => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/html",
          "x-api-key": RAW_KEY,
          "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000005",
        },
        body: JSON.stringify(jsonrpc("ping")),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
  it("DELETE ends the session with 200", async () => {
    const res = await mcpRoutes.request(
      "/",
      {
        method: "DELETE",
        headers: {
          "x-api-key": RAW_KEY,
          "X-VideoQ-Test-User-Id": "00000000-0000-4000-8000-000000000005",
          accept: "application/json, text/event-stream",
        },
      },
      ENV,
    );
    expect(res.status).toBe(200);
  });

  it("notification without id returns 202", async () => {
    const res = await post(jsonrpc("notifications/initialized", undefined, null));
    expect(res.status).toBe(202);
  });
});

describe("MCP connector CORS", () => {
  const app = createApp();

  it.each(["/api/mcp", "/api/auth/oauth2/token"])("OPTIONS %s allows browser DPoP with wildcard origin and no credentials", async (path) => {
    const res = await app.request(
      path,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization,content-type,accept,mcp-protocol-version,dpop",
        },
      },
      ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const allowHeaders = (
      res.headers.get("Access-Control-Allow-Headers") ?? ""
    ).toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("mcp-protocol-version");
    expect(allowHeaders).toContain("accept");
    expect(allowHeaders).toContain("dpop");
    const expose = (
      res.headers.get("Access-Control-Expose-Headers") ?? ""
    ).toLowerCase();
    expect(expose).toContain("www-authenticate");
  });

  it("401 exposes WWW-Authenticate for browser clients", async () => {
    const res = await app.request(
      "/api/mcp",
      {
        method: "POST",
        headers: {
          Origin: "https://claude.ai",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(jsonrpc("initialize", initializeParams)),
      },
      ENV,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    const expose = (
      res.headers.get("Access-Control-Expose-Headers") ?? ""
    ).toLowerCase();
    expect(expose).toContain("www-authenticate");
  });
});
