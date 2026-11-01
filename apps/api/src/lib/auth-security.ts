import type { AuthContext, BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  sensitiveSessionMiddleware,
} from "better-auth/api";
import {
  getOAuthProviderApi,
  type OAuthOptions,
  type OAuthProviderExtension,
  type OAuthRefreshToken,
} from "@better-auth/oauth-provider";
import { z } from "zod";

type OAuthConsentGrant = {
  id: string;
  userId: string | null;
  clientId: string;
  scopes: string[];
};

export function isBanned(user: object): boolean {
  if (!("banned" in user) || user.banned !== true) return false;
  // Match the Admin plugin's temporary-ban expiry semantics for non-session
  // credentials as well. Its session creation hook clears expired bans.
  const expires = "banExpires" in user ? user.banExpires : null;
  return !((expires instanceof Date || typeof expires === "string") &&
    new Date(expires).getTime() < Date.now());
}

function invalidGrant(): never {
  throw new APIError("BAD_REQUEST", {
    error: "invalid_grant",
    error_description: "Authorization has expired or been revoked. Authorize the application again.",
  });
}

/** Current consent is enough; reconnecting does not create a private token generation. */
export async function hasOAuthConsent(
  adapter: AuthContext["adapter"], userId: string, clientId: string, scopes: readonly string[],
): Promise<boolean> {
  const consent = await adapter.findOne<Pick<OAuthConsentGrant, "scopes">>({
    model: "oauthConsent",
    select: ["scopes"],
    where: [
      { field: "userId", value: userId },
      { field: "clientId", value: clientId },
    ],
  });
  return Boolean(consent && scopes.every((scope) => consent.scopes.includes(scope)));
}

async function findRefreshToken(
  ctx: GenericEndpointContext, options: OAuthOptions<string[]>, token: string,
) {
  const prefix = options.prefix?.refreshToken;
  if (prefix) {
    if (!token.startsWith(prefix)) return null;
    token = token.slice(prefix.length);
  }
  if (options.formatRefreshToken) token = (await options.formatRefreshToken.decrypt(token)).token;
  return ctx.context.adapter.findOne<OAuthRefreshToken<string[]>>({
    model: "oauthRefreshToken",
    where: [{
      field: "token",
      value: await getOAuthProviderApi(ctx, options).hashToken(token, "refresh_token"),
    }],
  });
}

/** Native code exchange supplies validated input through tokenResponseFields below. */
async function checkRefreshConsent(ctx: GenericEndpointContext, options: OAuthOptions<string[]>) {
  const parsedBody = z.object({ grant_type: z.string(), refresh_token: z.string(), scope: z.unknown().optional() }).safeParse(ctx.body);
  if (!parsedBody.success) return;
  const body = parsedBody.data;
  if (typeof body.grant_type !== "string" || body.grant_type.trim() !== "refresh_token" ||
    typeof body.refresh_token !== "string") return;
  const token = await findRefreshToken(ctx, options, body.refresh_token);
  // Missing/replayed credentials stay with the provider's rotation and family-revocation handling.
  if (!token || token.revoked) return;
  if (!token.userId || !token.clientId || !await hasOAuthConsent(ctx.context.adapter, token.userId, token.clientId,
    typeof body.scope === "string" ? body.scope.split(" ") : token.scopes,
  )) invalidGrant();
}

const introspectionSchema = z.object({
  active: z.literal(true),
  sub: z.string(),
});

// Native UserInfo validates the credential. Only the account ban is additional
// policy; consent/client changes take effect when the short-lived JWT expires.
export const videoqOAuthAccountPolicy: OAuthProviderExtension = {
  claims: {
    // eslint-disable-next-line @typescript-eslint/require-await -- Keep policy failures as rejected Promises for callers.
    userInfo: async ({ user }) => {
      if (isBanned(user)) {
        throw new APIError("UNAUTHORIZED", { error: "invalid_token" }, {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
        });
      }
      return {};
    },
  },
};

type TokenResponseFields = NonNullable<OAuthOptions<string[]>["customTokenResponseFields"]>;

/** Application policy only; the provider owns code storage, PKCE and rotation. */
export function videoqAuthSecurity(options: OAuthOptions<string[]>): BetterAuthPlugin & {
  tokenResponseFields: TokenResponseFields;
} {
  // Per-auth-instance state: createAuth is request-scoped, never a module singleton.
  let context: AuthContext | undefined;
  return {
    id: "videoq-auth-security",
    tokenResponseFields: async ({ user, scopes, verificationValue }) => {
      if (!user || isBanned(user)) invalidGrant();
      if (verificationValue) {
        if (!context) throw new Error("VideoQ auth policy was not initialized");
        if (!await hasOAuthConsent(context.adapter, user.id, verificationValue.query.client_id, scopes)) {
          invalidGrant();
        }
      }
      return {};
    },
    init(authContext) {
      context = authContext;
      return {
        options: {
          emailAndPassword: {
            enabled: authContext.options.emailAndPassword?.enabled ?? false,
            onPasswordReset: async ({ user }) => {
              await authContext.internalAdapter.updateUser(user.id, { passwordResetRequired: false });
            },
          },
        },
      };
    },
    hooks: {
      before: [{
        matcher: ({ path }) => path !== "/sign-out",
        handler: createAuthMiddleware(async (ctx) => {
          // This reads the underlying session endpoint, not auth.api, so it
          // does not recursively invoke this hook. Never authorize from cache.
          const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
          if (session && isBanned(session.user)) {
            throw new APIError("FORBIDDEN", {
              code: "USER_INACTIVE",
              message: "User is inactive",
            });
          }
        }),
      }, {
        matcher: ({ path }) => path === "/admin/set-role" || path === "/admin/update-user" || path === "/admin/create-user",
        handler: createAuthMiddleware(async (ctx) => {
          const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
          const isAdmin = session && "role" in session.user && typeof session.user.role === "string" &&
            session.user.role.split(",").includes("admin");
          // Leave authentication/permission errors to the native Admin plugin.
          // A server-only createUser call is also allowed, with the same two roles.
          if (session ? !isAdmin : ctx.request || ctx.headers) return;
          const body: unknown = ctx.body;
          if (!body || typeof body !== "object") return;
          const data = "data" in body ? body.data : undefined;
          const nestedRole = data && typeof data === "object" && "role" in data ? data.role : undefined;
          const role = ctx.path === "/admin/update-user"
            ? nestedRole
            : ("role" in body ? body.role : undefined) ?? nestedRole;
          if (role === undefined) return;
          if (role !== "user" && role !== "admin") {
            throw new APIError("BAD_REQUEST", { message: "Role must be user or admin." });
          }
          // Match the native endpoint's coercion (e.g. [id] also becomes id).
          const targetId = z.coerce.string().safeParse("userId" in body ? body.userId : undefined);
          if (ctx.path !== "/admin/create-user" && targetId.success &&
            session?.user.id === targetId.data && role !== "admin") {
            throw new APIError("BAD_REQUEST", { message: "Cannot remove your own administrator role." });
          }
        }),
      }, {
        matcher: ({ path }) => path === "/oauth2/token",
        handler: createAuthMiddleware(async (ctx) => { await checkRefreshConsent(ctx, options); }),
      }, {
        matcher: ({ path }) => path === "/oauth2/delete-consent",
        // Extend the standard endpoint through a documented before hook;
        // do not mutate the OAuth provider's endpoint definitions.
        handler: createAuthMiddleware({ use: [sensitiveSessionMiddleware] }, async (ctx) => {
          const body = z.object({ id: z.string().min(1) }).safeParse(ctx.body);
          if (!body.success) throw new APIError("BAD_REQUEST", { message: "Invalid consent id" });
          await deleteOAuthGrant(ctx.context.adapter, ctx.context.session.user.id, body.data.id);
          return ctx.json({ success: true });
        }),
      }],
      after: [{
        matcher: ({ path }) => path === "/oauth2/introspect",
        handler: createAuthMiddleware(async (ctx) => {
          // Native introspection owns token/session revocation. Its remaining
          // application policy is rejecting banned or deleted owners, including
          // offline tokens that no longer have an associated browser session.
          const result = ctx.context.returned;
          if (!result || typeof result !== "object" || !("active" in result) || result.active !== true) return;
          const parsed = introspectionSchema.safeParse(result);
          if (!parsed.success) return ctx.json({ active: false });
          const user = await ctx.context.internalAdapter.findUserById(parsed.data.sub);
          if (!user || isBanned(user)) return ctx.json({ active: false });
        }),
      }],
    },
  };
}

export async function deleteOAuthGrant(
  adapter: AuthContext["adapter"],
  userId: string,
  consentId: string,
): Promise<void> {
  await adapter.transaction(async (tx) => {
    const consent = await tx.findOne<OAuthConsentGrant>({
      model: "oauthConsent",
      where: [{ field: "id", value: consentId }, { field: "userId", value: userId }],
    });
    if (!consent) throw new APIError("NOT_FOUND", { message: "Authorization not found" });
    const where = [
      { field: "userId", value: userId },
      { field: "clientId", value: consent.clientId },
    ];
    // Deleting refresh rows also removes cached rotation replay responses.
    // Delete access tokens first because they can reference refresh rows.
    await tx.deleteMany({ model: "oauthAccessToken", where });
    await tx.deleteMany({ model: "oauthRefreshToken", where });
    await tx.deleteMany({ model: "oauthConsent", where });
  });
}
