import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { isAPIError } from "better-auth/api";
import { parseAccessTokenAuthorization, requestToResourceInput } from "better-auth/oauth2";
import type { AppEnv } from "../types/bindings";
import { toErrorBody } from "../shared/errors";
import { withAuth } from "../persistence/auth";
import type { ResourceAccessResult } from "../lib/auth-access";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../lib/mcp-auth";

/**
 * Cookie session/API key/OAuth の各認証方式は共通の結果型を返す:
 *   - absent : 資格情報が無い → 次の方式を試す
 *   - invalid: 資格情報はあるが不正 → 401 で打ち切り
 *   - ok     : 認証成功（userId 確定）
 */
type AuthVia = "apikey" | "session" | "oauth";

export type AuthOutcome =
  | { kind: "ok"; userId: string; via: AuthVia; accessLevel?: string }
  | { kind: "absent" }
  | Exclude<ResourceAccessResult, { kind: "ok" }>;

export type AuthMethod = (c: Context<AppEnv>) => Promise<AuthOutcome>;

function parseAuthHeader(
  c: Context<AppEnv>,
): { keyword: string; value: string } | null {
  const header = c.req.header("Authorization");
  if (!header) return null;
  const idx = header.indexOf(" ");
  if (idx < 0) return null;
  return { keyword: header.slice(0, idx), value: header.slice(idx + 1).trim() };
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * テスト用の認証ヘッダ（`X-VideoQ-Test-*`）を受け付けてよいか。
 *
 * `ENVIRONMENT` だけを条件にすると、`--env production` を付け忘れて deploy した
 * Worker が「誰にでもなりすませる公開エンドポイント」になる。実際に本番の
 * Hyperdrive を共有しているので、ホスト名がローカルであることも必須にする。
 */
function allowsTestAuthHeaders(c: Context<AppEnv>): boolean {
  if (c.env.ENVIRONMENT === "production") return false;
  return LOCAL_HOSTNAMES.has(new URL(c.req.url).hostname);
}

/** Better Auth user ids are string UUIDs (text PK). */
function toUserId(raw: unknown): string | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id.length > 0 ? id : null;
  }
  return null;
}

/** Better Auth cookie session. */
export const sessionMethod: AuthMethod = async (c) => {
  // Vitest / local route tests: inject user id without minting a real BA session.
  if (allowsTestAuthHeaders(c)) {
    const testUser = c.req.header("X-VideoQ-Test-User-Id");
    if (testUser) {
      const userId = toUserId(testUser);
      if (userId) return { kind: "ok", userId, via: "session" };
    }
  }

  return withAuth<AuthOutcome>(c.env, async auth => {
    // Authorization decisions must observe session revocation and account changes
    // immediately. Better Auth's signed cookie cache is suitable for display-only
    // session reads, but would otherwise keep a revoked session usable until expiry.
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    });
    if (!session?.user) return { kind: "absent" };
    const userId = toUserId(session.user.id);
    if (!userId) return { kind: "invalid", message: "Invalid session" };
    return { kind: "ok", userId, via: "session" };
  }, "browser").catch((error: unknown): AuthOutcome => {
    // Server-side Better Auth calls throw APIError instead of an HTTP response.
    // Translate only auth refusals; database/server failures must remain errors.
    if (isAPIError(error) && (error.statusCode === 401 || error.statusCode === 403)) {
      return { kind: "invalid", message: "Invalid session" };
    }
    throw error;
  });
};

const apiKeyMethodWithKeyword = (keyword: string): AuthMethod => async (c) => {
  const headerKey = c.req.header("X-API-Key")?.trim();
  const authz = parseAuthHeader(c);
  const raw =
    headerKey || (authz?.keyword.toLowerCase() === keyword.toLowerCase() ? authz.value : undefined);

  if (!raw) return { kind: "absent" };
  if (!raw.startsWith("vq_") || raw.length < 12) return { kind: "absent" };

  // Vitest fakes do not run Better Auth's apikey verifier; allow explicit test injection.
  if (allowsTestAuthHeaders(c)) {
    const testUser = c.req.header("X-VideoQ-Test-User-Id");
    if (testUser) {
      const userId = toUserId(testUser);
      const accessLevel =
        c.req.header("X-VideoQ-Test-Access-Level") ?? "all";
      if (userId) return { kind: "ok", userId, via: "apikey", accessLevel };
    }
  }

  return withAuth(c.env, async auth => {
    return auth.api.verifyVideoqApiKey({ body: { key: raw } });
  });
};

export const apiKeyMethod = apiKeyMethodWithKeyword("ApiKey");
export const bearerApiKeyMethod = apiKeyMethodWithKeyword("Bearer");

/**
 * OAuth 2 Bearer access token (MCP / third-party clients) via Better Auth
 * oauth-provider / JWT verification.
 */
export const oauthBearerMethod: AuthMethod = async (c) => {
  const authz = parseAccessTokenAuthorization(c.req.header("Authorization"));
  if (
    !authz ||
    (authz.scheme !== "Bearer" && authz.scheme !== "DPoP") ||
    !authz.token
  ) {
    return { kind: "absent" };
  }
  if (authz.token.startsWith("vq_")) return { kind: "absent" };

  if (allowsTestAuthHeaders(c)) {
    const testOauth = c.req.header("X-VideoQ-Test-OAuth-User-Id");
    if (testOauth) {
      const userId = toUserId(testOauth);
      if (userId) {
        const scopes = new Set(
          (c.req.header("X-VideoQ-Test-OAuth-Scopes") ??
            `${MCP_READ_SCOPE} ${MCP_WRITE_SCOPE}`)
            .split(/\s+/)
            .filter(Boolean),
        );
        if (!scopes.has(MCP_READ_SCOPE)) {
          return {
            kind: "forbidden",
            message: "OAuth token lacks videoq.read scope",
            requiredScope: MCP_READ_SCOPE,
          };
        }
        return {
          kind: "ok",
          userId,
          via: "oauth",
          accessLevel: scopes.has(MCP_WRITE_SCOPE) ? "all" : "read_only",
        };
      }
    }
  }

  return withAuth(c.env, async auth => {
    return auth.api.verifyVideoqOAuth({ body: requestToResourceInput(c.req.raw) });
  });
};

export const requireAuth = (...methods: AuthMethod[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const result = await resolveAuth(c, methods);
    if (result.kind === "ok") {
      return next();
    }
    if (result.kind === "invalid") {
      return c.json(toErrorBody("UNAUTHORIZED", result.message), 401);
    }
    if (result.kind === "forbidden") {
      return c.json(toErrorBody("FORBIDDEN", result.message), 403);
    }
    return c.json(
      toErrorBody("UNAUTHORIZED", "Authentication credentials were not provided."),
      401,
    );
  });

/** Authenticate once and populate Hono variables for either HTTP or tRPC handlers. */
export async function resolveAuth(
  c: Context<AppEnv>,
  methods: readonly AuthMethod[],
): Promise<AuthOutcome> {
  for (const method of methods) {
    const result = await method(c);
    if (result.kind === "ok") {
      c.set("userId", result.userId);
      c.set("authVia", result.via);
      if (result.accessLevel) {
        c.set("apiKeyAccessLevel", result.accessLevel);
      }
      return result;
    }
    if (result.kind === "invalid" || result.kind === "forbidden") {
      return result;
    }
  }
  return { kind: "absent" };
}

export function isScopeAllowed(
  accessLevel: string,
  requiredScope: string,
): boolean {
  if (accessLevel === "all") return true;
  if (accessLevel === "read_only") return requiredScope === "read";
  return false;
}

export const requireScope = (scope?: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const accessLevel = c.var.apiKeyAccessLevel;
    if (c.var.authVia === "apikey") {
      const required =
        scope ??
        (["GET", "HEAD", "OPTIONS"].includes(c.req.method) ? "read" : "write");
      if (!isScopeAllowed(accessLevel ?? "", required)) {
        return c.json(
          toErrorBody(
            "FORBIDDEN",
            "This API key does not have permission for this action.",
          ),
          403,
        );
      }
    }
    await next();
  });
