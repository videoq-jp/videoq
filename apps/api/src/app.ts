import { features } from "./lib/deployment";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { trpcServer } from "@hono/trpc-server";
import { TRPC_MAX_BATCH_SIZE } from "@videoq/trpc/schema";
import type { AppEnv } from "./types/bindings";
import { requestId } from "./middleware/request-id";
import { accessLogger } from "./middleware/logger";
import { corsMiddleware } from "./middleware/cors";
import { securityHeaders } from "./middleware/security-headers";
import { onError } from "./middleware/error-handler";
import { toErrorBody } from "./shared/errors";
import { healthRoutes } from "./features/health/routes";
import { videoRoutes } from "./features/videos/routes";
import { chatRoutes } from "./features/chat/routes";
import { mcpRoutes } from "./features/mcp/routes";
import { mediaRoutes } from "./features/media/routes";
import { billingRoutes } from "./features/billing/routes";
import { withDb } from "./db/pool";
import { authBaseURL, createAuth } from "./lib/auth";
import { createTrpcContext } from "./trpc/context";
import { appRouter } from "@videoq/trpc/router";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "./lib/mcp-auth";
import { limitChatTrpcRequestBody } from "./features/chat/body-limit";
import { loggablePath } from "./shared/log-path";
import { safeErrorStack, summarizeAuthApiError } from "./lib/auth-error-log";

/**
 * Hono アプリの組み立て。認証は Better Auth (`/api/auth/*`)。
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", requestId);
  app.use("*", accessLogger);
  app.use("*", securityHeaders);
  app.use("*", corsMiddleware);

  // Bound protocol bodies before auth, JSON parsing or webhook signature checks.
  // Binary uploads use their separate upload route; chat keeps its stricter cap.
  const limitProtocolBody = bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: (c) => c.json(toErrorBody("PAYLOAD_TOO_LARGE", "Request body must not exceed 4 MiB."), 413),
  });
  for (const path of ["/api/auth/*", "/api/trpc/*", "/api/mcp/*", "/api/billing/*"]) {
    app.use(path, limitProtocolBody);
  }

  app.onError(onError);

  app.route("/", healthRoutes);

  // Better Auth handler (sessions, email/password, API keys, OAuth AS).
  app.on(["POST", "GET"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
    if (!features(c.env).publicSignup && [
      "/api/auth/sign-up/email", "/api/auth/sign-in/social", "/api/auth/callback/google",
      "/api/auth/request-password-reset", "/api/auth/send-verification-email", "/api/auth/verify-email",
      "/api/auth/change-email", "/api/auth/update-user/email",
    ].includes(path)) return c.json(toErrorBody("FEATURE_DISABLED", "This feature is unavailable in this deployment."), 404);
    return withDb(c.env, async (db) => {
      const browserOnly = [
        "/api/auth/get-session",
        "/api/auth/sign-in/social",
        "/api/auth/callback/google",
      ].includes(new URL(c.req.url).pathname);
      const auth = createAuth(c.env, db, browserOnly ? "browser" : "full");
      return auth.handler(c.req.raw);
    });
  });

  // OAuth / OIDC discovery at well-known roots (MCP clients expect these).
  const authorizationServerMetadata = async (c: Context<AppEnv>) => {
    return withDb(c.env, async (db) => {
      const auth = createAuth(c.env, db);
      // Plugin typing does not always surface oauth metadata helpers on Auth.
      return oauthProviderAuthServerMetadata(auth as never)(c.req.raw);
    });
  };
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  // RFC 8414 issuer-path forms used by MCP clients.
  app.get("/.well-known/oauth-authorization-server/api/auth", authorizationServerMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", authorizationServerMetadata);
  app.get("/.well-known/oauth-authorization-server/api/mcp", authorizationServerMetadata);
  app.get("/.well-known/openid-configuration", async (c) => {
    return withDb(c.env, async (db) => {
      const auth = createAuth(c.env, db);
      return oauthProviderOpenIdConfigMetadata(auth as never)(c.req.raw);
    });
  });
  const protectedResourceMetadata = async (c: Context<AppEnv>) => {
    const site = authBaseURL(c.env, new URL(c.req.url).origin);
    const scopes = [MCP_READ_SCOPE, MCP_WRITE_SCOPE];
    const resourceClient = oauthProviderResourceClient().getActions();
    return c.json(await resourceClient.getProtectedResourceMetadata({
      resource: `${site}/api/mcp`,
      authorization_servers: [`${site}/api/auth`],
      scopes_supported: scopes,
    }, { externalScopes: scopes }));
  };
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  // RFC 9728 path form. MCP 401 の resource_metadata が指す先。
  app.get("/.well-known/oauth-protected-resource/api/mcp", protectedResourceMetadata);

  // All application JSON operations are exposed through tRPC.
  app.use("/api/trpc/*", limitChatTrpcRequestBody);
  app.use("/api/trpc/*", async (c: Context<AppEnv, string>, next) =>
    (trpcServer({
      endpoint: "/api/trpc",
      router: appRouter,
      maxBatchSize: TRPC_MAX_BATCH_SIZE,
      createContext: () => createTrpcContext(c),
      onError({ error, path, type }) {
        if (error.code !== "INTERNAL_SERVER_ERROR") return;
        const cause = error.cause ?? error;
        console.error(JSON.stringify({
          level: "error",
          requestId: c.var.requestId,
          path: loggablePath(c.req.url),
          procedure: path,
          type,
          code: error.code,
          error: summarizeAuthApiError(cause),
          // Error messages can contain SQL parameters, emails, or tokens.
          stack: safeErrorStack(cause),
        }));
      },
    }) as MiddlewareHandler<AppEnv>)(c, next),
  );

  // Raw HTTP is reserved for protocol-specific transports and binary payloads.
  app.route("/api/billing", billingRoutes);
  app.route("/api/videos", videoRoutes);
  app.route("/api/chat", chatRoutes);
  app.route("/api/mcp", mcpRoutes);
  app.route("/api/media", mediaRoutes);

  app.notFound((c) => c.json(toErrorBody("NOT_FOUND", "Not found"), 404));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
