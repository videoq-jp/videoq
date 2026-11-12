import { toolJwks } from "./tool-keys";
import { decodeJwt } from "jose";
import { launchLocale, resolveLtiLocale } from "./locale";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../../types/bindings";
import { toErrorBody } from "../../shared/errors";
import { clientIp, enforceThrottles, throttledResponse } from "../../lib/rate-limit";
import { getCourseWithMembers } from "../../repositories/chat-repository";
import { courseAccessContext } from "./course-access";
import { ltiConfig, type LtiRegistration } from "./config";
import { resolvedLtiConfig } from "./registrations";
import { loginRecord, sessionRecord, verifyLaunch } from "./protocol";
import { consumeLogin, digest, putCredential, randomSecret, readCredential } from "./store";
import { loginView, questionView } from "./view";
import { mountLearningRoutes } from "./learning-routes";
import { registrationFingerprint, learningFeatures } from "./session-authorization";

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
  const candidates = config.registrations.filter(reg => reg.issuer === params.get("iss")
    && (!params.get("client_id") || reg.clientId === params.get("client_id")));
  if (candidates.length !== 1 || !params.get("login_hint")) return refused(c);
  const reg = candidates[0];
  const target = config.toolOrigin + "/api/lti/launch";
  if (params.get("target_link_uri") !== target) return refused(c);
  const deploymentHint = params.get("lti_deployment_id") || undefined;
  if (deploymentHint && reg.deploymentId !== deploymentHint && !reg.resources.some(item => item.deploymentId === deploymentHint)) return refused(c);
  const locale = resolveLtiLocale(c.req.header("Accept-Language"));
  const state = randomSecret(), nonce = randomSecret(), browserSecret = randomSecret();
  await putCredential(c.env, state, "login", {
    registrationId: reg.id, locale, nonce, browserHash: await digest(browserSecret), target, deploymentHint,
  }, 300);
  const url = new URL(reg.authorizationUrl);
  const authParams: Record<string, string> = {
    scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none",
    client_id: reg.clientId, redirect_uri: target, login_hint: params.get("login_hint")!, state, nonce,
  };
  if (params.get("lti_message_hint")) authParams.lti_message_hint = params.get("lti_message_hint")!;
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
  const login = loginRecord.safeParse(await readCredential(c.env, input.data.state, "login"));
  if (!login.success || login.data.browserHash !== await digest(input.data.browserSecret)) return refused(c, 401);
  const reg = config.registrations.find(item => item.id === login.data.registrationId);
  if (!reg) return refused(c, 401);
  let launch;
  try { launch = await verifyLaunch(input.data.id_token, reg, login.data); }
  catch { return refused(c, 401); }
  const course = await getCourseWithMembers(c.env, { courseId: launch.courseId, ltiCourseGrant: launch.courseId });
  if (!course || (launch.videoId !== undefined && !course.memberVideoIds.includes(launch.videoId))) return refused(c, 403);
  let current;
  try { current = await courseAccessContext(reg, launch, c.env); } catch { return refused(c, 403); }
  const allowed = current?.videos ?? null;
  const playbackVideoId = launch.videoId ?? allowed?.[0]?.videoId;
  if (launch.videoId && current && ![...current.videos, ...(current.managementVideos ?? [])].some(video => video.videoId === launch.videoId)) return refused(c, 403);
  if (!await consumeLogin(c.env, input.data.state)) return refused(c, 401);
  const token = randomSecret();
  const { subject, ...grant } = launch;
  await putCredential(c.env, await digest(token), "session", {
    ...grant, ...(allowed ? { scopeVideoIds: allowed.map(video => video.videoId).sort((a,b)=>a-b) } : {}), registrationId: reg.id, registrationHash: await registrationFingerprint(reg),
    subjectHash: await digest(JSON.stringify([reg.issuer, reg.clientId, grant.deploymentId, subject])),
  }, 3600);
  return c.json({ token, expiresIn: 3600, learningAvailable: !current || current.videos.length > 0,
    features: learningFeatures(reg),
    ...(playbackVideoId ? { playback: { videoId: playbackVideoId, parentOrigins: reg.frameOrigins, ...(allowed ? { videos: allowed } : {}) } } : {}),
  });
});

async function authorize(c: Context<AppEnv>) {
  const config = (await resolvedLtiConfig(c.env))!;
  if (c.req.header("Origin") !== config.toolOrigin) return { error: refused(c, 403) } as const;
  const token = c.req.header("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return { error: refused(c, 401) } as const;
  const session = sessionRecord.safeParse(await readCredential(c.env, await digest(token), "session"));
  if (!session.success || session.data.transport === "native") return { error: refused(c, 401) } as const;
  const grant = session.data;
  const reg = config.registrations.find(item => item.id === grant.registrationId);
  // Re-read bindings on every request: removal immediately revokes existing sessions.
  if (!reg || grant.registrationHash !== await registrationFingerprint(reg) || !reg.resources.some(item => item.deploymentId === grant.deploymentId && item.contextId === grant.contextId
    && item.resourceLinkId === grant.resourceLinkId && item.courseId === grant.courseId
    && item.videoId === grant.videoId && item.generation === grant.resourceGeneration)) return { error: refused(c, 403) } as const;
  return { grant, reg, sessionHash: await digest(token) } as const;
}

mountLearningRoutes(ltiRoutes, authorize, refused);
