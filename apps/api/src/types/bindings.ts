/**
 * Worker のバインディングと Hono の Variables（リクエストスコープの値）。
 * Cloudflare リソースと wrangler vars は `npm run cf-typegen` の生成型を使う。
 * オンプレでは文字列設定を読み替え、Cloudflare リソースを Node 用の接続先で置き換える。
 */
import type pg from "pg";
import type { RateLimitBackend } from "../lib/rate-limit";

type SecretBindings = {
  BETTER_AUTH_SECRET?: string;
  AUTH_JWT_SECRET?: string;
  USER_SECRET_ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  MAILGUN_API_KEY?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

// Keep generated binding names/types, while allowing deployment-specific string
// values and runtimes without Cloudflare resources.
type RuntimeStrings = {
  [K in keyof CloudflareBindings as NonNullable<CloudflareBindings[K]> extends string ? K : never]: string;
};
type PlatformResources = {
  [K in keyof CloudflareBindings as NonNullable<CloudflareBindings[K]> extends string ? never : K]?: CloudflareBindings[K];
};

export type Bindings = Omit<RuntimeStrings, keyof SecretBindings | "OPENAI_BASE_URL"> & PlatformResources &
  SecretBindings & {
    RUNTIME?: "node";
    DEFAULT_MONTHLY_UPLOAD_LIMIT_GB?: string;
    DEPLOYMENT_EDITION?: "cloud" | "onprem";
    DATABASE_URL?: string;
    /** Only the long-lived Node runtime supplies a shared pool. */
    DATABASE_POOL?: pg.Pool;
    RATE_LIMIT_BACKEND?: RateLimitBackend;
    // 互換用の任意設定。
    OPENAI_BASE_URL?: string;
    OPENROUTER_FEDERATION_POLICY_ID?: string;
    OPENROUTER_FEDERATION_AUDIENCE?: string;
    LLM_BASE_URL?: string;
    LLM_API_KEY?: string;
    EMBEDDING_BASE_URL?: string;
    EMBEDDING_API_KEY?: string;
    EMBEDDING_PROFILE?: string;
    LLM_REASONING_EFFORT?: "none" | "minimal" | "low" | "medium" | "high";
    LLM_SEPARATE_TOOL_SCHEMA?: string;
    LLM_PRESERVE_TOOL_REASONING?: string;
    LLM_REQUEST_TIMEOUT_MS?: string;
    LLM_STREAM_TIMEOUT_MS?: string;
    AWS_SESSION_TOKEN?: string;
    R2_S3_INTERNAL_ENDPOINT?: string;

    STRIPE_AUTOMATIC_TAX?: string;
  };

// ミドルウェアが c.set/c.get で受け渡す値
type Variables = {
  requestId: string;
  userId?: string;
  // 認証経路。share = 共有スラッグ経由の匿名アクセス。
  authVia?: "apikey" | "session" | "share" | "oauth";
  // API キー認証時の access_level（"all" | "read_only"）。scope 判定に使う。
  apiKeyAccessLevel?: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
