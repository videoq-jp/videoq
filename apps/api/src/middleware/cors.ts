import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types/bindings";

/** MCP / OAuth クライアントが付けるプロトコル固有ヘッダ。 */
const PROTOCOL_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "DPoP",
  "X-API-Key",
  "Accept",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Mcp-Method",
  "Mcp-Name",
  "Last-Event-ID",
];

const PROTOCOL_EXPOSE_HEADERS = [
  "WWW-Authenticate",
  "Mcp-Session-Id",
  "X-Request-Id",
];

const PROTOCOL_ALLOW_METHODS = ["GET", "POST", "DELETE", "OPTIONS"];

/**
 * MCP / OAuth の公開プロトコル経路か。
 * これらは SPA Cookie ではなく外部 MCP クライアント向けなので、
 * `Access-Control-Allow-Origin: *`（credentials なし）で応答する。
 */
function isMcpProtocolPath(pathname: string): boolean {
  return (
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/") ||
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/api/auth/oauth2/") ||
    pathname === "/api/auth/oauth2/register" ||
    pathname.startsWith("/api/auth/.well-known/")
  );
}

/**
 * CORS。
 * - MCP / OAuth プロトコル: `*` + credentials なし（Claude Code / claude.ai コネクタ向け）
 * - それ以外: env の許可オリジンに限定し credentials(Cookie) を許可
 */
export const corsMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const pathname = new URL(c.req.url).pathname;

  if (isMcpProtocolPath(pathname)) {
    const handler = cors({
      origin: "*",
      allowHeaders: PROTOCOL_ALLOW_HEADERS,
      allowMethods: PROTOCOL_ALLOW_METHODS,
      exposeHeaders: PROTOCOL_EXPOSE_HEADERS,
      maxAge: 86400,
    });
    return handler(c, next);
  }

  const allowed = (c.env.CORS_ALLOW_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const handler = cors({
    // Comma-separated list in env (e.g. localhost + 127.0.0.1 for Vite).
    // Return the request origin only when allowlisted; otherwise omit ACAO.
    origin: (origin) => (origin && allowed.includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Request-Id"],
  });
  return handler(c, next);
});
