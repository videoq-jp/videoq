import { features } from "./deployment";
import { betterAuth, type DBAdapterInstance } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
  admin,
  jwt,
  username,
} from "better-auth/plugins";
import type { Bindings } from "../types/bindings";
import { sendMail } from "./mail";
import { authLogger, summarizeAuthApiError } from "./auth-error-log";
import { rateLimitBackend } from "./rate-limit";
import { MCP_OAUTH_SCOPES } from "./mcp-auth";
import { resolveSignupQuotaDefaults } from "../shared/signup-quota";
import { videoqAuthSecurity, videoqOAuthAccountPolicy } from "./auth-security";
import { videoqResourceAccess } from "./auth-access";
import type { OAuthGrantRepository } from "../persistence/contracts/oauth-grant-repository";

function trustedOrigins(env: Bindings): string[] {
  return (env.CORS_ALLOW_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function authSecret(env: Bindings): string {
  const secret = env.BETTER_AUTH_SECRET?.trim() || env.AUTH_JWT_SECRET?.trim();
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  return secret;
}

/** The first email approves the change; only the second completes it. */
function emailChangeMailUrl(url: string, stage: "approval" | "verification"): string {
  const link = new URL(url);
  const callbackURL = link.searchParams.get("callbackURL");
  if (!callbackURL) return url;
  const callback = new URL(callbackURL, link);
  // Leave other callers' callback pages unchanged. This is a display hint for
  // the app's confirmation page, never an authorization or verification check.
  if (!/^\/(?:en\/|ja\/)?change-email\/?$/.test(callback.pathname)) return url;
  if (stage === "approval") callback.searchParams.set("step", "verify-new");
  else if (callback.searchParams.get("step") === "verify-new") callback.searchParams.delete("step");
  else return url;
  link.searchParams.set("callbackURL", callback.href);
  return link.href;
}

export function authBaseURL(env: Bindings, fallback = "http://localhost"): string {
  return (
    env.BETTER_AUTH_URL?.trim() ||
    env.OAUTH_ISSUER_URL?.trim() ||
    env.FRONTEND_URL?.trim() ||
    fallback
  ).replace(/\/+$/, "");
}

/** OAuth access tokenの発行・検証で共有する唯一のresource audience。 */
export const oauthResourceAudience = (env: Bindings): string =>
  `${authBaseURL(env)}/api/mcp`;

export function oauthProviderConfig(env: Bindings) {
  const resource = oauthResourceAudience(env);
  return {
    scopes: [...MCP_OAUTH_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    extensions: [videoqOAuthAccountPolicy],
    // Accept native JWT expiry instead of a database consent check on every
    // request. Bound both resource JWTs and resource-less opaque access tokens.
    accessTokenExpiresIn: 5 * 60,
    resources: [
      {
        identifier: resource,
        name: "VideoQ MCP",
        allowedScopes: [...MCP_OAUTH_SCOPES],
        accessTokenTtl: 5 * 60,
      },
    ],
    resourceSeedMode: "merge" as const,
    clientRegistrationDefaultResources: [resource],
    clientRegistrationAllowedResources: [resource],
    loginPage: "/login",
    consentPage: "/consent",
    // MCP clients (Claude etc.) need unauthenticated DCR for public clients.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Confidential clients from DCR get a bounded secret lifetime.
    clientRegistrationClientSecretExpiration: "30d",
    rateLimit: {
      register: { window: 60, max: 5 },
      token: { window: 60, max: 20 },
      authorize: { window: 60, max: 30 },
    },
    // The Hono app explicitly exposes the RFC 8414 issuer-path route.
    silenceWarnings: { oauthAuthServerConfig: true },
  };
}

/** Normalize an email local-part (or name) into a BA username candidate. */
export function usernameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  let base = local
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base.length < 3) base = `user_${base}`.replace(/_+/g, "_");
  if (base.length < 3) base = "user";
  return base.slice(0, 150);
}

async function allocateUniqueUsername(usernameExists: (candidate: string) => Promise<boolean>, preferred: string): Promise<string> {
  let seed = preferred.includes("@")
    ? usernameFromEmail(preferred)
    : preferred
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 150);
  if (seed.length < 3) seed = usernameFromEmail(preferred.includes("@") ? preferred : `${seed || "user"}@x`);

  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : `_${i}`;
    const candidate = `${seed.slice(0, Math.max(1, 150 - suffix.length))}${suffix}`;
    if (!await usernameExists(candidate)) return candidate;
  }
  return `user_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

type AuthRateLimitStorage = NonNullable<
  NonNullable<Parameters<typeof betterAuth>[0]["rateLimit"]>["customStorage"]
>;

/** Better Auth 側のレート制限窓。DO に載るのでこの値が全 isolate 共通になる。 */
const AUTH_RATE_LIMIT_WINDOW_SEC = 60;

/** パスワード再設定トークンの有効期限。案内メールの文面と必ず一致させる。 */
const PASSWORD_RESET_TOKEN_TTL_SEC = 15 * 60;

/**
 * Better Auth のレート制限を RateLimiter Durable Object に載せる。
 *
 * 既定の `memory` ストレージは isolate ごとに独立するため、Workers では
 * ログイン・登録・パスワード再設定・OAuth の制限を、別 isolate に当たるだけで
 * 迂回できてしまう。DO なら 1 キー = 1 インスタンスで直列化される。
 */
export function durableRateLimitStorage(env: Bindings): AuthRateLimitStorage {
  const backend = rateLimitBackend(env);
  // アプリ側スコープ（`throttle_*`）とキー空間を分ける。
  const scoped = (key: string) => `better_auth_${key}`;
  return {
    async consume(key, rule) {
      const { allowed, retryAfterSec } = await backend.consume(
        scoped(key),
        rule.max,
        rule.window,
      );
      return { allowed, retryAfter: allowed ? null : retryAfterSec };
    },
  };
}

/**
 * Per-request Better Auth configuration with injected persistence operations.
 * Do not reuse across requests — the adapter lifetime belongs to the caller.
 * The browser profile serves only session reads and native Google sign-in;
 * MCP/OAuth/API-key callers must use the default full profile.
 */
export type AuthPersistence = {
  adapter: DBAdapterInstance;
  usernameExists: (candidate: string) => Promise<boolean>;
  /** Atomic override for adapters without interactive transactions. */
  oauthGrants?: OAuthGrantRepository;
};

export function createAuthWithPersistence(env: Bindings, persistence: AuthPersistence, profile: "full" | "browser" = "full", delivery?: { passwordReset: (link: { url: string; token: string }) => Promise<void> }) {
  const quota = resolveSignupQuotaDefaults(env);
  const baseURL = authBaseURL(env);
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const googleEnabled = features(env).googleLogin && Boolean(googleClientId && googleClientSecret);
  const oauthConfig = oauthProviderConfig(env);
  const security = videoqAuthSecurity(oauthConfig, persistence.oauthGrants);

  return betterAuth({
    database: persistence.adapter,
    secret: authSecret(env),
    baseURL,
    basePath: "/api/auth",
    trustedOrigins: trustedOrigins(env),
    logger: authLogger,
    onAPIError: {
      errorURL: `${(env.FRONTEND_URL ?? baseURL).replace(/\/+$/, "")}/login`,
      onError: (error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "better_auth_api_error",
            ...summarizeAuthApiError(error),
          }),
        );
      },
    },
    // OAuth provider owns /oauth2/token; disable BA's first-party /token alias.
    disabledPaths: ["/token"],
    verification: {
      // OAuth codes already have provider-owned hashing; only reset identifiers
      // need this core option. No custom digest format or cleanup namespace.
      storeIdentifier: { default: "plain", overrides: { "reset-password:": "hashed" } },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !features(env).publicSignup,
      requireEmailVerification: features(env).publicSignup,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      // 案内メールの文面と同じ値を明示しておき、既定値の変更で乖離させない。
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_TTL_SEC,
      sendResetPassword: async ({ user, url, token }) => {
        if (delivery) return delivery.passwordReset({ url, token });
        await sendMail(env, user.email, "[VideoQ] パスワード再設定のご案内", [
          "VideoQ のパスワード再設定リクエストを受け付けました。",
          `${PASSWORD_RESET_TOKEN_TTL_SEC / 60}分以内に、以下のURLから新しいパスワードを設定してください。`,
          "",
          url,
          "",
          "もしこのリクエストに心当たりがない場合は、このメールを破棄してください。",
        ]);
      },
    },
    emailVerification: {
      sendOnSignUp: features(env).publicSignup,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail(env, user.email, "[VideoQ] メールアドレスの確認", [
          "VideoQ のメールアドレス確認リクエストを受け付けました。",
          "以下のURLをクリックして、このメールアドレスの確認を完了させてください。",
          "",
          emailChangeMailUrl(url, "verification"),
        ]);
      },
    },
    socialProviders: googleEnabled
      ? {
          google: {
            clientId: googleClientId!,
            clientSecret: googleClientSecret!,
            prompt: "select_account",
            requireEmailVerification: true,
            mapProfileToUser: async (profile) => {
              const email =
                typeof profile.email === "string" ? profile.email : "";
              // Google is authoritative for Gmail and hosted Workspace mail.
              // A third-party email may have changed owners since Google
              // originally verified it; require our own mailbox verification.
              const authoritativeEmail = email.toLowerCase().endsWith("@gmail.com") ||
                (typeof profile.hd === "string" && profile.hd.trim().length > 0);
              const preferred =
                typeof profile.name === "string" && profile.name.trim()
                  ? profile.name.trim()
                  : email;
              const allocated = await allocateUniqueUsername(persistence.usernameExists, email || preferred);
              return {
                name: preferred || allocated,
                email,
                emailVerified: profile.email_verified === true && authoritativeEmail,
                image: typeof profile.picture === "string" ? profile.picture : undefined,
                username: allocated,
                displayUsername: allocated,
              };
            },
          },
        }
      : {},
    account: {
      // Encrypt provider access/refresh tokens with the auth secret at rest.
      // Better Auth still accepts legacy plaintext tokens during the transition.
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
      },
    },
    user: {
      additionalFields: {
        quotaSource: { type: "string", required: false, defaultValue: features(env).billing ? "plan" : "admin", input: false },
        maxVideoUploadSizeMb: {
          type: "number",
          required: true,
          defaultValue: quota.maxVideoUploadSizeMb,
          input: false,
        },
        aiAnswersLimit: {
          type: "number",
          required: false,
          defaultValue: quota.aiAnswersLimit,
          input: false,
        },
        isOverQuota: {
          type: "boolean",
          required: true,
          defaultValue: false,
          input: false,
        },
        processingLimitMinutes: {
          type: "number",
          required: false,
          defaultValue: quota.processingLimitMinutes,
          input: false,
        },
        monthlyUploadLimitGb: {
          type: "number", required: false, defaultValue: quota.monthlyUploadLimitGb, input: false,
        },
        storageLimitGb: {
          type: "number",
          required: false,
          defaultValue: quota.storageLimitGb,
          input: false,
        },
        usedAiAnswers: {
          type: "number",
          required: true,
          defaultValue: 0,
          input: false,
        },
        usedProcessingSeconds: {
          type: "number",
          required: true,
          defaultValue: 0,
          input: false,
        },
        usedStorageBytes: {
          type: "number",
          required: true,
          defaultValue: 0,
          input: false,
        },
        firstName: {
          type: "string",
          required: true,
          defaultValue: "",
          input: false,
        },
        lastName: {
          type: "string",
          required: true,
          defaultValue: "",
          input: false,
        },
        passwordResetRequired: {
          type: "boolean",
          required: true,
          defaultValue: false,
          input: false,
        },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await sendMail(env, user.email, "[VideoQ] メールアドレス変更の承認", [
            "VideoQ のメールアドレス変更リクエストを受け付けました。",
            `現在のアカウント: ${user.email}`,
            `変更先のメールアドレス: ${newEmail}`,
            "変更を承認する場合は、以下のURLをクリックしてください。承認後、新しいメールアドレスへ確認メールを送信します。",
            "",
            emailChangeMailUrl(url, "approval"),
            "",
            "このリクエストに心当たりがない場合は、リンクを開かないでください。",
          ]);
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        // All Better Auth endpoints must observe suspension and revocation.
        enabled: false,
      },
    },
    advanced: {
      // Keep origin/CSRF enforcement identical in tests and deployed Workers.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // Better Auth default: string UUIDs for all models including user.
      database: {
        generateId: () => crypto.randomUUID(),
      },
      // Cloudflare Workers uses a single, edge-controlled client IP header.
      // X-Forwarded-For keeps the local Caddy reverse proxy usable; Better Auth
      // rejects multi-hop values unless trusted proxies are configured.
      ipAddress: {
        ipAddressHeaders: env.RUNTIME === "node"
          ? ["x-videoq-client-ip"]
          : ["cf-connecting-ip", "x-forwarded-for"],
      },
      useSecureCookies: env.ENVIRONMENT === "production",
      defaultCookieAttributes: {
        sameSite: "lax",
        httpOnly: true,
        path: "/",
      },
    },
    rateLimit: {
      enabled: true,
      window: AUTH_RATE_LIMIT_WINDOW_SEC,
      max: 100,
      // serverless では memory ストレージが isolate 間で共有されない。
      customStorage: durableRateLimitStorage(env),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const q = resolveSignupQuotaDefaults(env);
            let username =
              typeof user.username === "string" && user.username.trim()
                ? user.username.trim()
                : undefined;
            if (!username) {
              username = await allocateUniqueUsername(
                persistence.usernameExists,
                typeof user.email === "string" ? user.email : "user",
              );
            }
            const displayUsername =
              typeof user.displayUsername === "string" && user.displayUsername.trim()
                ? user.displayUsername
                : username;
            const name =
              (typeof user.name === "string" && user.name) ||
              username ||
              user.email;
            return {
              data: {
                ...user,
                name,
                username,
                displayUsername,
                maxVideoUploadSizeMb: q.maxVideoUploadSizeMb,
                aiAnswersLimit: q.aiAnswersLimit,
                processingLimitMinutes: q.processingLimitMinutes,
                storageLimitGb: q.storageLimitGb,
                monthlyUploadLimitGb: q.monthlyUploadLimitGb,
                isOverQuota: false,
                usedAiAnswers: 0,
                usedProcessingSeconds: 0,
                usedStorageBytes: 0,
                firstName: "",
                lastName: "",
                passwordResetRequired: false,
              },
            };
          },
        },
      },
    },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 150,
      }),
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      // Session reads and Google sign-in do not serve MCP/OAuth-provider/API-key
      // endpoints. Avoid rebuilding those plugins (including OAuth resource
      // seeding) on every browser request under the Free Worker's CPU budget.
      // Keep username/admin/security and the same account policy in both profiles.
      ...(profile === "full" ? [
        apiKey(["default", "read-write"].map((configId) => ({
          configId,
          defaultPrefix: "vq_",
          apiKeyHeaders: ["x-api-key"],
          permissions: {
            defaultPermissions: { videoq: configId === "read-write" ? ["read", "write"] : ["read"] },
          },
          startingCharactersConfig: {
            shouldStore: true,
            charactersLength: 8,
          },
        }))),
        jwt(),
        oauthProvider({ ...oauthConfig, customTokenResponseFields: security.tokenResponseFields }),
      ] : []),
      security,
      ...(profile === "full" ? [videoqResourceAccess(env, oauthResourceAudience(env))] : []),
    ],
  });
}
