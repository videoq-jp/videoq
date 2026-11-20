import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AppEnv, Bindings } from "../../types/bindings";
import { rateLimitBackend } from "../../lib/rate-limit";
import { WORKERS_EMBEDDING_MODEL } from "../../lib/workers-ai";

const MODEL = "@cf/openai/whisper-large-v3-turbo";
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
type Trust = Pick<Bindings, "WORKERS_AI_FEDERATION_ISSUER" | "WORKERS_AI_FEDERATION_AUDIENCE" | "WORKERS_AI_FEDERATION_SUBJECT">;

function trustConfigured(env: Trust): boolean {
  return /^https:\/\/[a-f0-9-]{36}\.tokens\.sts\.global\.api\.aws$/.test(env.WORKERS_AI_FEDERATION_ISSUER ?? "")
    && !!env.WORKERS_AI_FEDERATION_AUDIENCE && !!env.WORKERS_AI_FEDERATION_SUBJECT;
}

/** Trust only configured AWS keys; never follow a token-provided jku/issuer. */
export async function verifyWorkersAiIdentity(token: string, env: Trust, testKey?: JWTVerifyGetKey): Promise<void> {
  if (!trustConfigured(env)) throw new Error("Workers AI trust is not configured");
  const issuer = env.WORKERS_AI_FEDERATION_ISSUER!;
  let key = testKey ?? keys.get(issuer);
  if (!key) {
    const remote = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { timeoutDuration: 5000 });
    keys.set(issuer, remote);
    key = remote;
  }
  const { payload } = await jwtVerify(token, key, {
    issuer, audience: env.WORKERS_AI_FEDERATION_AUDIENCE,
    subject: env.WORKERS_AI_FEDERATION_SUBJECT, algorithms: ["RS256"],
    requiredClaims: ["iat", "exp"], maxTokenAge: "15m", clockTolerance: 5,
  });
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (aud.length !== 1 || aud[0] !== env.WORKERS_AI_FEDERATION_AUDIENCE
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
    || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 900) {
    throw new Error("Invalid workload identity claims");
  }
}

export const workersAiRoutes = new Hono<AppEnv>();
workersAiRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!c.env.AI || !trustConfigured(c.env)) return c.json({ error: "Workers AI unavailable" }, 503);
  const auth = c.req.header("Authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.length > 16391) return c.json({ error: "Unauthorized" }, 401);
  try { await verifyWorkersAiIdentity(auth.slice(7), c.env); }
  catch { return c.json({ error: "Unauthorized" }, 401); }
  // One shared Durable Object bucket per verified role, across tokens/isolates.
  // Lambda's 10 media consumers have headroom; token refresh cannot reset it.
  if (!c.env.RATE_LIMITER && !c.env.RATE_LIMIT_BACKEND) return c.json({ error: "Rate limiter unavailable" }, 503);
  try {
    const result = await rateLimitBackend(c.env).consume(`workers-ai:inference:${c.env.WORKERS_AI_FEDERATION_SUBJECT}`, 120, 60);
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSec));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
  } catch { return c.json({ error: "Rate limiter unavailable" }, 503); }
  await next();
});
workersAiRoutes.post("/embeddings", bodyLimit({ maxSize: 512 * 1024,
  onError: c => c.json({ error: "Embedding request too large" }, 413) }), async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid embedding input" }, 400);
  const { texts, input_type } = body as Record<string, unknown>;
  if (!Array.isArray(texts) || !texts.length || texts.length > 32
    || texts.some(text => typeof text !== "string" || !text.trim() || text.length > 8192)
    || !["query", "document"].includes(String(input_type))) return c.json({ error: "Invalid embedding input" }, 400);
  const prefix = input_type === "query" ? "task: search result | query: " : "title: none | text: ";
  try {
    const result = await c.env.AI!.run(WORKERS_EMBEDDING_MODEL, {
      input: texts.map(text => prefix + text), dimensions: 768, encoding_format: "float",
    });
    return c.json(result);
  } catch { return c.json({ error: "Workers AI embeddings failed" }, 502); }
});
// Authentication precedes reading or parsing potentially large audio bodies.
workersAiRoutes.use("*", bodyLimit({ maxSize: 6 * 1024 * 1024,
  onError: c => c.json({ error: "Audio request too large" }, 413) }));
workersAiRoutes.post("/transcribe", async c => {
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Expected JSON" }, 415);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid audio" }, 400);
  const { audio, language } = body as Record<string, unknown>;
  if (typeof audio !== "string" || !audio.length || audio.length > 5592408
    || (audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio))
    || atob(audio).length > 4 * 1024 * 1024
    || (language !== undefined && (typeof language !== "string" || !/^[a-z]{2,3}$/.test(language)))) {
    return c.json({ error: "Invalid audio or language" }, 400);
  }
  try {
    const result = await c.env.AI!.run(MODEL, {
      audio, task: "transcribe", vad_filter: true, condition_on_previous_text: false,
      ...(typeof language === "string" ? { language } : {}),
    });
    return c.json({ success: true, result });
  } catch {
    // Provider exceptions may include submitted audio. Never log or return them.
    return c.json({ error: "Workers AI inference failed" }, 502);
  }
});
