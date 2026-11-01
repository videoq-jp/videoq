import { AwsClient } from "aws4fetch";
import { deadlineSignal } from "./request-timeout";

export type FederationSettings = {
  OPENROUTER_FEDERATION_POLICY_ID?: string;
  OPENROUTER_FEDERATION_AUDIENCE?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
};

type Token = { value: string; expiresAt: number };
type Cache = { token?: Token; pending?: Promise<Token> };
const caches = new WeakMap<object, Cache>();

/** AWS signs the workload JWT; OpenRouter validates it and issues an inference token. */
export async function federatedOpenRouterToken(env: FederationSettings): Promise<string> {
  let cache = caches.get(env);
  if (!cache) { cache = {}; caches.set(env, cache); }
  if (cache.token && cache.token.expiresAt > Date.now() + 60_000) return cache.token.value;
  if (!cache.pending) {
    cache.pending = exchange(env).then(token => { cache.token = token; return token; })
      .finally(() => { cache.pending = undefined; });
  }
  return (await cache.pending).value;
}

async function exchange(env: FederationSettings): Promise<Token> {
  const policy = env.OPENROUTER_FEDERATION_POLICY_ID;
  const region = env.AWS_REGION;
  if (!policy || !region || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)
    || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("OpenRouter federation requires a policy ID, AWS_REGION and AWS workload credentials.");
  }
  try {
    const startedAt = Date.now();
    const aws = new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN, region, service: "sts", retries: 0 });
    const result = await aws.fetch(`https://sts.${region}.amazonaws.com/`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Action: "GetWebIdentityToken", Version: "2011-06-15",
        "Audience.member.1": env.OPENROUTER_FEDERATION_AUDIENCE || "https://openrouter.ai",
        SigningAlgorithm: "RS256", DurationSeconds: "900" }).toString(),
      signal: deadlineSignal(10_000),
    });
    if (!result.ok) { await result.body?.cancel(); throw new Error("STS rejected workload identity."); }
    const xml = await result.text();
    const jwt = /<WebIdentityToken>([A-Za-z0-9_.-]+)<\/WebIdentityToken>/.exec(xml)?.[1];
    if (!jwt || jwt.length > 16384) throw new Error("Invalid STS workload identity.");
    const payload: unknown = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!payload || typeof payload !== "object" || !("exp" in payload) || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp * 1000 <= startedAt + 60_000) throw new Error("Expired workload identity.");
    const response = await fetch("https://openrouter.ai/api/v1/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt", federation_policy_id: policy,
        subject_token: jwt, scope: "inference" }), signal: deadlineSignal(10_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("OpenRouter rejected workload identity."); }
    const token = await response.json<Record<string, unknown>>();
    if (typeof token.access_token !== "string" || !token.access_token || token.token_type !== "Bearer"
      || token.scope !== "inference" || typeof token.expires_in !== "number"
      || !Number.isFinite(token.expires_in) || token.expires_in <= 60 || token.expires_in > 900) {
      throw new Error("Invalid OpenRouter federation response.");
    }
    const expiresAt = Math.min(startedAt + token.expires_in * 1000, payload.exp * 1000);
    if (expiresAt <= Date.now() + 60_000) throw new Error("Expired OpenRouter federation response.");
    return { value: token.access_token, expiresAt };
  } catch {
    // Never include JWTs, HTTP response bodies or signed AWS requests in errors.
    throw new Error("OpenRouter workload identity exchange failed. Check the AWS issuer, IAM permission and federation policy.");
  }
}
