import { toolJwks } from "./tool-keys";
import { decodeJwt } from "jose";
import { launchLocale, resolveLtiLocale } from "./locale";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../../types/bindings";
import { toErrorBody } from "../../shared/errors";
import { clientIp, enforceThrottles, throttledResponse } from "../../lib/rate-limit";
import { ltiConfig, type LtiRegistration } from "./config";
import { resolvedLtiConfig } from "./registrations";
import { loginRecord } from "./protocol";
import { randomSecret, readCredential } from "./store";
import { loginView, questionView } from "./view";
import { mountLearningRoutes } from "./learning-routes";
import { initiateLtiLogin, exchangeLtiLogin, authorizeLtiSession } from './session-service';
import { ltiSessionDependencies } from '../../integrations/lti-session';

export const ltiRoutes = new Hono<AppEnv>();
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
const tokenString = z.string().min(1).max(100_000);
const exchangeSchema = z.object({ state: opaque, browserSecret: opaque, id_token: tokenString }).strict();

function refused(c: Context<AppEnv>, status: 400 | 401 | 403 = 400) {
  return c.json(toErrorBody(status === 401 ? "UNAUTHORIZED" : "VALIDATION_ERROR", "LTI request could not be accepted. Relaunch from your LMS or contact the administrator."), status);
}
function framePolicy(c: Context<AppEnv>, reg: LtiRegistration, nonce: string) {
  c.header("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${reg.frameOrigins.join(" ")}`);
  c.header("Referrer-Policy", "no-referrer");
}
async function parameters(c: Context<AppEnv>): Promise<URLSearchParams> {
  if (c.req.method !== "GET" && !c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) throw new Error("Expected form post");
  const params = c.req.method === "GET" ? new URL(c.req.url).searchParams : new URLSearchParams(await c.req.text());
  if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) throw new Error("Duplicate parameters");
  return params;
}

const controlBodyLimit: MiddlewareHandler<AppEnv> = bodyLimit({ maxSize: 128 * 1024 });
ltiRoutes.use("*", (c: Context<AppEnv, string>, next) => {
  // The management route applies its own bounded SRT request budget.
  if (c.req.path.endsWith('/management')) return next();
  return controlBodyLimit(c, next);
});
ltiRoutes.use("*", async (c: Context<AppEnv>, next) => {
  c.header("Cache-Control", "no-store");
  if (!ltiConfig(c.env)) return c.json(toErrorBody("NOT_FOUND", "LTI is not configured."), 404);
  // Includes unauthenticated login/state creation and signature verification.
  const denied = await enforceThrottles(c.env, [
    { scope: "lti_request_ip", ident: clientIp(c) },
    ...(["/login", "/launch", "/session"].some(path => c.req.path.endsWith(path))
      ? [{ scope: "lti_launch_ip" as const, ident: clientIp(c) }] : []),
  ]);
  if (denied) return throttledResponse(c, denied);
  await next();
});

ltiRoutes.get("/jwks", async c => {
  return c.json(await toolJwks(c.env));
});

ltiRoutes.on(["GET", "POST"], "/login", async c => {
  const config = (await resolvedLtiConfig(c.env))!;
  let params: URLSearchParams;
  try { params = await parameters(c); } catch { return refused(c); }
  const target = config.toolOrigin + "/api/lti/launch";
  const locale = resolveLtiLocale(c.req.header("Accept-Language"));
  const initiated = await initiateLtiLogin(ltiSessionDependencies(c.env), config.registrations, target, {
    issuer: params.get('iss') ?? '', clientId: params.get('client_id') || undefined,
    loginHint: params.get('login_hint') || undefined, target: params.get('target_link_uri') ?? '',
    deploymentHint: params.get('lti_deployment_id') || undefined,
    messageHint: params.get('lti_message_hint') || undefined, locale,
  });
  if (!initiated) return refused(c);
  const { reg, state, nonce, browserSecret, deploymentHint } = initiated;
  const url = new URL(reg.authorizationUrl);
  const authParams: Record<string, string> = {
    scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none",
    client_id: reg.clientId, redirect_uri: target, login_hint: initiated.loginHint, state, nonce,
  };
  if (initiated.messageHint) authParams.lti_message_hint = initiated.messageHint;
  if (deploymentHint) authParams.lti_deployment_id = deploymentHint;
  for (const [key, value] of Object.entries(authParams)) url.searchParams.set(key, value);
  const scriptNonce = randomSecret();
  framePolicy(c, reg, scriptNonce);
  return c.html(loginView(scriptNonce, state, browserSecret, url.href, locale));
});

ltiRoutes.post("/launch", async c => {
  let params: URLSearchParams;
  try { params = await parameters(c); } catch { return refused(c); }
  const state = params.get("state"), idToken = params.get("id_token");
  if (!opaque.safeParse(state).success || !tokenString.safeParse(idToken).success) return refused(c);
  const login = loginRecord.safeParse(await readCredential(c.env, state!, "login"));
  if (!login.success) return refused(c);
  const reg = (await resolvedLtiConfig(c.env))!.registrations.find(item => item.id === login.data.registrationId);
  if (!reg) return refused(c);
  // Verify only after the browser proves possession of its login secret (/session).
  const nonce = randomSecret();
  framePolicy(c, reg, nonce);
  // This unverified hint selects static UI copy only; /session verifies all grants.
  let locale = login.data.locale ?? "en";
  try { locale = launchLocale(decodeJwt(idToken!), locale); } catch { /* Invalid tokens are rejected by /session. */ }
  return c.html(questionView(nonce, state!, idToken!, locale, reg.frameOrigins));
});

ltiRoutes.post("/session", async c => {
  const config = (await resolvedLtiConfig(c.env))!;
  if (c.req.header("Origin") !== config.toolOrigin) return refused(c, 403);
  const input = exchangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return refused(c);
  const result = await exchangeLtiLogin(ltiSessionDependencies(c.env), config.registrations, {
    state: input.data.state, browserSecret: input.data.browserSecret, idToken: input.data.id_token,
  });
  if (!result.ok) return refused(c, result.failure === 'unauthorized' ? 401 : 403);
  return c.json(result.value);
});

async function authorize(c: Context<AppEnv>) {
  const config = (await resolvedLtiConfig(c.env))!;
  if (c.req.header("Origin") !== config.toolOrigin) return { error: refused(c, 403) } as const;
  const token = c.req.header("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return { error: refused(c, 401) } as const;
  const result = await authorizeLtiSession(ltiSessionDependencies(c.env), config.registrations, token);
  if (!result.ok) return { error: refused(c, result.failure === 'unauthorized' ? 401 : 403) } as const;
  return result.value;
}

mountLearningRoutes(ltiRoutes, authorize, refused);
