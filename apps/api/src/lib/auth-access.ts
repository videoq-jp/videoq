import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { role } from "better-auth/plugins/access";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import { decodeProtectedHeader, errors as jwtErrors } from "jose";
import { z } from "zod";
import { apiKeyResourceAccess, oauthResourceAccess, parseResourceScopes, type ResourceAccessResult } from "../application/resource-access";
export type { ResourceAccessResult } from "../application/resource-access";

/**
 * Resource-server policy exposed only through auth.api, never HTTP endpoints.
 * Better Auth verifies credentials; this extension applies VideoQ account
 * status and read/write access policy to the verified identity.
 */
export function videoqResourceAccess(jwksCacheKey: object, audience: string) {
  return {
    id: "videoq-resource-access",
    endpoints: {
      verifyVideoqApiKey: createAuthEndpoint.serverOnly({
        method: "POST", body: z.object({ key: z.string() }),
      }, async (ctx): Promise<ResourceAccessResult> => {
        const plugin = ctx.context.getPlugin("api-key");
        if (!plugin) throw new Error("VideoQ requires the Better Auth API key plugin");
        const result = await plugin.endpoints.verifyApiKey({
          body: { ...ctx.body, permissions: { videoq: ["read"] } }, context: ctx.context,
        });
        if (!result.valid && (result.error?.code === "RATE_LIMITED" || result.error?.code === "USAGE_EXCEEDED")) {
          // Better Auth returns the retry delay in milliseconds. Never label an exhausted key invalid.
          const details: unknown = result.error;
          const parsed = z.object({ details: z.object({ tryAgainIn: z.number().nonnegative() }).optional() }).safeParse(details);
          return { kind: "rate_limited", message: "API key request limit exceeded.",
            retryAfterSec: Math.max(1, Math.ceil((parsed.success ? parsed.data.details?.tryAgainIn ?? 60_000 : 60_000) / 1000)) };
        }
        if (!result.valid || !result.key) return { kind: "invalid", message: "Invalid API key" };
        const key = result.key;
        const user = await ctx.context.internalAdapter.findUserById(key.referenceId);
        return apiKeyResourceAccess(user,
          () => role(key.permissions ?? {}).authorize({ videoq: ["write"] }).success, Date.now());
      }),
      verifyVideoqOAuth: createAuthEndpoint.serverOnly({
        method: "POST",
        body: z.object({
          authorizationHeader: z.string().nullish(),
          dpopProofJwt: z.string().nullish(),
          method: z.string(), url: z.string(),
        }),
      }, async (ctx): Promise<ResourceAccessResult> => {
        const authorization = parseAccessTokenAuthorization(ctx.body.authorizationHeader);
        if (!authorization?.token || authorization.scheme === "Unknown") {
          return { kind: "invalid", message: "Invalid OAuth access token" };
        }
        // The official verifier reads the header before signature validation.
        // Malformed input can throw TypeError there; isolate that pure parse
        // from verification so DB/JWKS TypeErrors still propagate as failures.
        try {
          decodeProtectedHeader(authorization.token);
        } catch {
          return { kind: "invalid", message: "Invalid OAuth access token" };
        }
        const jwt = ctx.context.getPlugin("jwt");
        if (!jwt) throw new Error("VideoQ requires the Better Auth JWT plugin");
        let payload;
        try {
          // verifyAccessTokenRequest currently accepts only a remote JWKS URL.
          // Workers cannot fetch their own same-zone Route, so compose the
          // public verifier and DPoP helper with the JWT plugin's local endpoint.
          payload = await verifyJwsAccessToken(authorization.token, {
            jwksFetch: () => jwt.endpoints.getJwks({ context: ctx.context }),
            jwksCacheKey,
            verifyOptions: { issuer: ctx.context.baseURL, audience },
          });
          await enforceDpopBinding({
            payload, authorization, proofJwt: ctx.body.dpopProofJwt,
            method: ctx.body.method, url: ctx.body.url,
            replayStore: createDpopReplayStore(ctx.context.internalAdapter),
          });
        } catch (error) {
          // Match Better Auth's resource verifier: malformed credentials are
          // refusals, while database/JWKS/replay-store failures remain errors.
          const invalidJwt = error instanceof jwtErrors.JOSEError && !(
            error instanceof jwtErrors.JWKSInvalid ||
            error instanceof jwtErrors.JWKSTimeout ||
            error instanceof jwtErrors.JWKSMultipleMatchingKeys
          );
          if (invalidJwt || isDpopBindingError(error)) {
            const challenge = createResourceServerChallenge(
              isDpopBindingError(error) ? new APIError("UNAUTHORIZED", {
                error: error.code, error_description: error.message,
              }) : new APIError("UNAUTHORIZED"),
              audience,
            );
            return {
              kind: "invalid", message: "Invalid OAuth access token",
              wwwAuthenticate: new Headers(challenge?.headers).get("WWW-Authenticate") ?? undefined,
            };
          }
          throw error;
        }
        // The composed verifier has no scope parser. Keep this RFC 6749 shape
        // check until the standard request verifier supports local JWKS.
        const scopes = parseResourceScopes(payload.scope);
        if (scopes === null) return { kind: "invalid", message: "Invalid OAuth access token" };
        const userId = payload.sub;
        if (!userId || typeof payload.client_id !== "string" || !payload.client_id) {
          return { kind: "invalid", message: "Invalid OAuth access token" };
        }
        // A disconnected client's existing JWT remains usable until native
        // expiry (five minutes for new tokens). Bans still apply immediately.
        const user = await ctx.context.internalAdapter.findUserById(userId);
        return oauthResourceAccess(userId, user, scopes, Date.now());
      }),
    },
  } satisfies BetterAuthPlugin;
}
