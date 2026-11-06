import { toolJwks } from "./tool-keys";
import { decodeJwt } from "jose";
import { launchLocale, resolveLtiLocale } from "./locale";
import { appendCourseHistory, readCourseHistory } from "./history";
import { streamSSE } from "hono/streaming";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { chatMessagesSchema } from "@videoq/trpc/schema";
import type { AppEnv } from "../../types/bindings";
import { toErrorBody } from "../../shared/errors";
import { clientIp, enforceThrottles, throttledResponse } from "../../lib/rate-limit";
import { getVideoEvidence } from "../../repositories/video-evidence-repository";
import { courseAccess } from "./course-access";
import { playbackCueHint } from "./playback-context";
import { getCourseWithMembers, updateChatLogFeedback } from "../../repositories/chat-repository";
import { sendChatMessage, streamChatMessage } from "../chat/message-service";
import { ltiConfig, type LtiRegistration } from "./config";
import { resolvedLtiConfig } from "./registrations";
import { loginRecord, sessionRecord, verifyLaunch } from "./protocol";
import { consumeLogin, digest, putCredential, randomSecret, readCredential, recordScopeVideos } from "./store";
import { loginView, questionView } from "./view";

export const ltiRoutes = new Hono<AppEnv>();
function registrationFingerprint(reg: LtiRegistration) {
  // A different lesson changing must not interrupt this lesson's conversation.
  // Database resources are checked individually, including their generation.
  return digest(JSON.stringify(reg.id.startsWith("db:") ? { ...reg, resources: [] } : reg));
}
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
const tokenString = z.string().min(1).max(100_000);
const exchangeSchema = z.object({ state: opaque, browserSecret: opaque, id_token: tokenString }).strict();
const messageSchema = z.object({
  messages: chatMessagesSchema,
  playback: z.object({
    video_id: z.number().int().positive().safe(),
    position_seconds: z.number().min(0).max(604800),
  }).strict().optional(),
}).strict().refine(
  input => input.messages.at(-1)?.role === "user", "The last message must be a question",
);
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

ltiRoutes.use("*", bodyLimit({ maxSize: 128 * 1024 }));
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
  let allowed;
  try { allowed = await courseAccess(reg, launch, c.env); } catch { return refused(c, 403); }
  if (launch.videoId && allowed && !allowed.some(video => video.videoId === launch.videoId)) return refused(c, 403);
  if (!await consumeLogin(c.env, input.data.state)) return refused(c, 401);
  const token = randomSecret();
  const { subject, ...grant } = launch;
  await putCredential(c.env, await digest(token), "session", {
    ...grant, ...(allowed ? { scopeVideoIds: allowed.map(video => video.videoId).sort((a,b)=>a-b) } : {}), registrationId: reg.id, registrationHash: await registrationFingerprint(reg),
    subjectHash: await digest(JSON.stringify([reg.issuer, reg.clientId, grant.deploymentId, subject])),
  }, 3600);
  return c.json({ token, expiresIn: 3600,
    ...(launch.videoId ? { playback: { videoId: launch.videoId, parentOrigins: reg.frameOrigins, ...(allowed ? { videos: allowed } : {}) } } : {}),
  });
});

async function authorize(c: Context<AppEnv>) {
  const config = (await resolvedLtiConfig(c.env))!;
  if (c.req.header("Origin") !== config.toolOrigin) return { error: refused(c, 403) } as const;
  const token = c.req.header("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return { error: refused(c, 401) } as const;
  const session = sessionRecord.safeParse(await readCredential(c.env, await digest(token), "session"));
  if (!session.success) return { error: refused(c, 401) } as const;
  const grant = session.data;
  const reg = config.registrations.find(item => item.id === grant.registrationId);
  // Re-read bindings on every request: removal immediately revokes existing sessions.
  if (!reg || grant.registrationHash !== await registrationFingerprint(reg) || !reg.resources.some(item => item.deploymentId === grant.deploymentId && item.contextId === grant.contextId
    && item.resourceLinkId === grant.resourceLinkId && item.courseId === grant.courseId
    && item.videoId === grant.videoId && item.generation === grant.resourceGeneration)) return { error: refused(c, 403) } as const;
  return { grant, reg, sessionHash: await digest(token) } as const;
}

async function feedbackReference(c: Context<AppEnv>, sessionHash: string, courseId: number, logId: number | null) {
  if (logId === null) return undefined;
  const id = randomSecret();
  await putCredential(c.env, await digest(id), "lti-feedback", { sessionHash, courseId, logId }, 3600);
  return id;
}

ltiRoutes.post("/history", async c => {
  const access = await authorize(c);
  if ("error" in access) return access.error;
  const { grant, reg, sessionHash } = access;
  const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]);
  if (denied) return throttledResponse(c, denied);
  let allowed;
  try { allowed = await courseAccess(reg, grant, c.env); } catch { return refused(c, 403); }
  const course = await getCourseWithMembers(c.env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId, ltiVideoGrant: allowed?.map(video => video.videoId) });
  if (!course) return refused(c, 403);
  const turns = await readCourseHistory(c.env, grant, course.userId, course.memberVideoIds);
  return c.json({ turns: await Promise.all(turns.map(async ({ logId, ...turn }) => ({ ...turn,
    feedbackId: await feedbackReference(c, sessionHash, grant.courseId, logId),
  }))) });
});

ltiRoutes.on("POST", ["/messages", "/messages/stream"], async c => {
  const access = await authorize(c);
  if ("error" in access) return access.error;
  const { grant, reg, sessionHash } = access;
  const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]);
  if (denied) return throttledResponse(c, denied);
  const input = messageSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return refused(c);
  let allowed;
  try { allowed = await courseAccess(reg, grant, c.env); } catch { return refused(c, 403); }
  const ltiVideoGrant = allowed?.map(video => video.videoId);
  // Do not feed prior answers from a newly restricted scope back into the model.
  const usedScope = allowed ? await recordScopeVideos(c.env, sessionHash, ltiVideoGrant!) : null;
  if (allowed && !usedScope) return refused(c, 401);
  const scopeChanged = usedScope?.some(id => !ltiVideoGrant!.includes(id));
  const messagesInput = scopeChanged ? [input.data.messages.at(-1)!] : input.data.messages;
  let messages = messagesInput;
  if (input.data.playback) {
    const playback = input.data.playback;
    if (allowed ? !ltiVideoGrant!.includes(playback.video_id) : grant.videoId !== playback.video_id) return refused(c, 403);
    const course = await getCourseWithMembers(c.env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId, ltiVideoGrant });
    if (!course?.memberVideoIds.includes(playback.video_id)) return refused(c, 403);
    const seconds = Math.floor(playback.position_seconds);
    const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
    const video = await getVideoEvidence(c.env, { ownerUserId: course.userId, videoIds: course.memberVideoIds }, playback.video_id);
    const cueHint = playbackCueHint(video?.transcript ?? null, playback.position_seconds);
    const last = messages.at(-1)!;
    const contextual = chatMessagesSchema.safeParse([...messages.slice(0, -1), {
      role: "user", content: `[視聴中の教材情報: 動画ID ${playback.video_id}、再生位置 ${time} (${seconds}秒)。「今の場面」「この説明」への質問では、この動画の字幕を確認し、再生位置を含む字幕区間を特定して、その区間の内容を中心に回答してください。${cueHint}]\n${last.content}`,
    }]);
    if (!contextual.success) return refused(c);
    messages = contextual.data;
  }
  if (c.req.path.endsWith("/stream")) {
    const connection = new AbortController();
    const result = await streamChatMessage(c.env, {
      userId: null, shareSlug: null, ltiCourseGrant: grant.courseId, ltiVideoGrant,
      body: { messages, course_id: grant.courseId }, locale: grant.locale,
      clientSignal: AbortSignal.any([c.req.raw.signal, connection.signal]),
    });
    c.header("Content-Encoding", "Identity");
    c.header("X-Accel-Buffering", "no");
    const response = streamSSE(c, async stream => {
      stream.onAbort(() => connection.abort());
      try {
        if (allowed) await stream.writeSSE({ data: JSON.stringify({ type: "scope", videos: allowed }) });
        await result.write(async event => {
          if (event.type === "done") {
            await appendCourseHistory(c.env, grant, input.data.messages.at(-1)!.content, event.chat_log_id, ltiVideoGrant);
            const feedbackId = await feedbackReference(c, sessionHash, grant.courseId, event.chat_log_id);
            await stream.writeSSE({ data: JSON.stringify({ type: "done", feedbackId, feedback: event.feedback }) });
          } else await stream.writeSSE({ data: JSON.stringify(event) });
        });
      } catch {
        if (!connection.signal.aborted) await stream.writeSSE({ data: JSON.stringify({ type: "error", code: "STREAM_FAILED", message: "Unable to complete the answer." }) });
      }
    });
    response.headers.set("Content-Type", "text/event-stream; charset=utf-8");
    return response;
  }
  const result = await sendChatMessage(c.env, {
    userId: null, shareSlug: null, ltiCourseGrant: grant.courseId, ltiVideoGrant,
    body: { messages, course_id: grant.courseId }, locale: grant.locale,
  });
  // Expose a session-bound feedback reference, never owner log IDs.
  if (result.status !== 200 || !("answer" in result.body)) return c.json(result.body, result.status);
  await appendCourseHistory(c.env, grant, input.data.messages.at(-1)!.content, result.body.chat_log_id ?? null, ltiVideoGrant);
  const feedbackId = await feedbackReference(c, sessionHash, grant.courseId, result.body.chat_log_id ?? null);
  return c.json({ answer: result.body.answer, ...(feedbackId ? { feedbackId, feedback: result.body.feedback ?? null } : {}), ...(allowed ? { videos: allowed } : {}) });
});


ltiRoutes.post("/feedback", async c => {
  const access = await authorize(c);
  if ("error" in access) return access.error;
  const input = z.object({ feedbackId: opaque, feedback: z.enum(["good", "bad"]).nullable() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return refused(c);
  const { grant, reg, sessionHash } = access;
  const ref = z.object({ sessionHash: z.string(), courseId: z.number().int().positive(), logId: z.number().int().positive() })
    .safeParse(await readCredential(c.env, await digest(input.data.feedbackId), "lti-feedback"));
  if (!ref.success || ref.data.sessionHash !== sessionHash || ref.data.courseId !== grant.courseId) return refused(c, 403);
  try { await courseAccess(reg, grant, c.env); } catch { return refused(c, 403); }
  if (!await getCourseWithMembers(c.env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId })) return refused(c, 403);
  const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]);
  if (denied) return throttledResponse(c, denied);
  const updated = await updateChatLogFeedback(c.env, ref.data.logId, input.data.feedback, { ltiCourseGrant: grant.courseId });
  if ("notFound" in updated || "forbidden" in updated) return refused(c, 403);
  return c.json({ feedback: updated.feedback });
});
