import type { Context } from "hono";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { StreamableHTTPTransport } from "@hono/mcp";
import { CallToolRequestSchema, isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { APIError } from "better-auth/api";
import { createInsufficientScopeError } from "better-auth/oauth2";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { authBaseURL } from "../../lib/auth";
import {
  oauthBearerMethod,
  bearerApiKeyMethod,
  apiKeyMethod,
  isScopeAllowed,
  requireScope,
} from "../../middleware/auth";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../../lib/mcp-auth";
import { MANAGEMENT_WRITE_TOOLS, type ManagementToolName } from "../../tools/management";
import { toErrorBody } from "../../shared/errors";
import type { AppEnv } from "../../types/bindings";
import { createVideoqMcpServer } from "./server";

/**
 * MCP Streamable HTTP（@hono/mcp）。
 * 認証順: OAuth Bearer → Bearer API キー → X-API-Key/ApiKey。
 * 読み取りツールは read_only キーでも利用でき、書き込みツールは個別に拒否する。
 */
export const mcpRoutes = new Hono<AppEnv>();

function mcpWwwAuthenticate(
  c: Context<AppEnv>,
  requiredScopes?: string[],
): string {
  const resource = `${authBaseURL(c.env, new URL(c.req.url).origin)}/api/mcp`;
  // Without a scope override, clients discover both read and write from the
  // resource metadata. Explicit read-only authorization remains supported.
  const challenge = createResourceServerChallenge(
    requiredScopes ? createInsufficientScopeError(requiredScopes) : new APIError("UNAUTHORIZED"),
    resource,
  );
  const header = new Headers(challenge?.headers).get("WWW-Authenticate");
  if (!header) throw new Error("Better Auth did not produce a resource challenge");
  return header;
}

async function requestedMcpScopes(c: Context<AppEnv>): Promise<string[]> {
  if (c.req.method === "POST" && c.req.header("Content-Type")?.includes("application/json")) {
    // Hono caches the parsed body for the MCP transport. Leave invalid JSON
    // and protocol validation to the transport, and support its batch requests.
    const body: unknown = await c.req.json().catch(() => undefined);
    const messages = Array.isArray(body) ? body : [body];
    const writes = messages.some((message) => {
      if (!isJSONRPCRequest(message)) return false;
      const request = CallToolRequestSchema.safeParse(message);
      return request.success && MANAGEMENT_WRITE_TOOLS.has(request.data.params.name as ManagementToolName);
    });
    if (writes) return [MCP_READ_SCOPE, MCP_WRITE_SCOPE];
  }
  return [MCP_READ_SCOPE];
}

const mcpAuth = createMiddleware<AppEnv>(async (c, next) => {
  for (const method of [oauthBearerMethod, bearerApiKeyMethod, apiKeyMethod]) {
    const r = await method(c);
    if (r.kind === "ok") {
      if (r.via === "oauth" && !isScopeAllowed(r.accessLevel ?? "", "write")) {
        const scopes = await requestedMcpScopes(c);
        if (scopes.includes(MCP_WRITE_SCOPE)) {
          return c.json(toErrorBody("FORBIDDEN", "OAuth token lacks videoq.write scope"), 403, {
            "WWW-Authenticate": mcpWwwAuthenticate(c, scopes),
          });
        }
      }
      c.set("userId", r.userId);
      c.set("authVia", r.via);
      if (r.accessLevel) c.set("apiKeyAccessLevel", r.accessLevel);
      return next();
    }
    if (r.kind === "rate_limited") {
      return c.json(toErrorBody("RATE_LIMITED", r.message), 429, { "Retry-After": String(r.retryAfterSec) });
    }
    if (r.kind === "invalid") {
      return c.json(toErrorBody("UNAUTHORIZED", r.message), 401, {
        "WWW-Authenticate": r.wwwAuthenticate ?? mcpWwwAuthenticate(c),
      });
    }
    if (r.kind === "forbidden") {
      return c.json(toErrorBody("FORBIDDEN", r.message), 403, {
        "WWW-Authenticate": mcpWwwAuthenticate(c, await requestedMcpScopes(c)),
      });
    }
  }
  return c.json(
    toErrorBody("UNAUTHORIZED", "Authentication credentials were not provided."),
    401,
    { "WWW-Authenticate": mcpWwwAuthenticate(c) },
  );
});

/**
 * 一部クライアントは Accept に片方しか付けない。
 * GET は text/event-stream（またはワイルドカード）が必要なので補完する。
 */
const normalizeMcpAccept = createMiddleware<AppEnv>(async (c, next) => {
  const accept = c.req.header("Accept") ?? "";
  const hasJson = accept.includes("application/json") || accept.includes("*/*");
  const hasSse =
    accept.includes("text/event-stream") || accept.includes("*/*");
  if (!hasJson || !hasSse) {
    try {
      c.req.raw.headers.set("Accept", "application/json, text/event-stream");
    } catch {
      // Request headers が immutable な runtime ではそのまま進める。
    }
  }
  return next();
});

mcpRoutes.use("*", normalizeMcpAccept, mcpAuth, requireScope("read"));

mcpRoutes.all("/", async (c) => {
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createVideoqMcpServer({
    env: c.env,
    signal: c.req.raw.signal,
    userId: c.var.userId!,
    authVia: c.var.authVia,
    requestId: c.var.requestId,
    canWrite: isScopeAllowed(c.var.apiKeyAccessLevel ?? "", "write"),
  });
  await server.connect(transport);
  return transport.handleRequest(c);
});
