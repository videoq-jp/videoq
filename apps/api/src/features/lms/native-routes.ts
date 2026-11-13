import { classroomPlaybackVideo } from '../classroom/repository';
import { resolveFileUrl } from '../../integrations/media';
import { z } from 'zod';
import { withDb } from '../../db/pool';
import { ltiCredentials } from '../../db/schema';
import { MaterialsClient } from './connector-client';
import { issueTeachingTicket } from '../teaching/service';
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../../types/bindings";
import { ApiError, toErrorBody } from "../../shared/errors";
import { clientIp, enforceThrottles, throttledResponse } from "../../lib/rate-limit";
import { mountLearningRoutes, type LearningRefusal } from "../lti/learning-routes";
import { digest } from "../lti/store";
import { authorizeNativeRequest, verifyNativeAssertion } from "./native-auth";

export const nativeLearningRoutes = new Hono<AppEnv>();
const prefix = "/api/lms/native";
const operations = new Set(["/course-history", "/playback", "/teacher/connect", "/materials", "/transcript", "/history", "/messages", "/messages/stream",
  "/feedback", "/qa", "/conversations", "/management", "/tags", "/reports"]);
const refuse: LearningRefusal = (c, status = 400) =>
  c.json(toErrorBody(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", "The LMS learning request is unavailable."), status);
const limit = (maxSize: number): MiddlewareHandler<AppEnv> => bodyLimit({
  maxSize,
  onError: context => context.json(toErrorBody("VALIDATION_ERROR", "The learning request is too large."), 413),
});
const ordinaryLimit = limit(128 * 1024), managementLimit = limit(5 * 1024 * 1024);

nativeLearningRoutes.use("*", async (c: Context<AppEnv, string>, next) => {
  c.header("Cache-Control", "private, no-store");
  if (!operations.has(c.req.path.slice(prefix.length))) return c.notFound();
  if (c.req.method !== "POST") return c.json(toErrorBody("VALIDATION_ERROR", "POST is required."), 405);
  if (c.req.header("Origin") !== undefined || new URL(c.req.url).search) return refuse(c, 403);
  return (c.req.path.endsWith("/management") ? managementLimit : ordinaryLimit)(c, next);
});
nativeLearningRoutes.use("*", async (c: Context<AppEnv, string>, next) => {
  const denied = await enforceThrottles(c.env, [{ scope: "lti_request_ip", ident: clientIp(c) }]);
  if (denied) return throttledResponse(c, denied);
  const assertion = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!assertion) return refuse(c, 401);
  // Hash the bounded original bytes without consuming the downstream body.
  const bodySha256 = await digest(await c.req.raw.clone().text());
  if (c.req.path.endsWith('/teacher/connect')) {
    const input = z.object({ title: z.string().min(1).max(500).optional() }).strict().safeParse(await c.req.raw.clone().json());
    if (!input.success) return refuse(c);
    const { reg, claims } = await verifyNativeAssertion(c.env, assertion, '/teacher/connect', bodySha256);
    if (!reg.id.startsWith('db:') || !reg.materialsService || !reg.deploymentId) return refuse(c, 403);
    const access = await new MaterialsClient(c.env, { ...reg, deploymentId: reg.deploymentId, materialsService: reg.materialsService })
      .access(claims.contextId, claims.resourceLinkId, claims.subject);
    if (!access.permissions?.manageContent) return refuse(c, 403);
    const nonce = await digest(JSON.stringify(['teaching-link', reg.id, claims.jti]));
    const accepted = await withDb(c.env, db => db.insert(ltiCredentials).values({ id: nonce, kind: 'teaching-link-nonce',
      payload: {}, expiresAt: new Date((claims.exp + 60) * 1000) }).onConflictDoNothing().returning({ id: ltiCredentials.id }));
    if (!accepted.length) return refuse(c, 403);
    return c.json(await issueTeachingTicket(c.env, { provider: 'moodle', installationId: reg.id.slice(3),
      contextId: claims.contextId, teacherSubject: claims.subject, teacherName: claims.author?.name || 'Moodle user ' + claims.subject,
      title: input.data.title || 'Moodle ' + claims.contextId, resourceLinkId: claims.resourceLinkId,
      returnUrl: reg.issuer + '/course/view.php?id=' + encodeURIComponent(claims.contextId) }));
  }
  const authorization = await authorizeNativeRequest(c.env, assertion, c.req.path.slice(prefix.length), bodySha256);
  c.set("nativeLearningAuthorization", authorization);
  await next();
});
nativeLearningRoutes.onError((error, c) => {
  if (error instanceof ApiError) return c.json(toErrorBody(error.code, error.expose ? error.message : "The LMS learning request is unavailable."), error.status);
  console.error(JSON.stringify({ event: "moodle_native_request_failed" }));
  return c.json(toErrorBody("INTERNAL_ERROR", "The LMS learning service is unavailable."), 503);
});
nativeLearningRoutes.post('/playback', async c => {
  const access = c.get('nativeLearningAuthorization');
  const input = z.object({ videoId: z.number().int().positive().safe() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!access?.course || !input.success || !access.current?.videos.some(item => item.videoId === input.data.videoId)) return refuse(c, 403);
  const video = await classroomPlaybackVideo(c.env, access.course.userId, input.data.videoId);
  if (!video) return refuse(c, 403);
  if (video.sourceType === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(video.youtubeId))
    return c.json({ kind: 'youtube', title: video.title, description: video.description, url: `https://www.youtube-nocookie.com/embed/${video.youtubeId}` });
  const url = await resolveFileUrl(c.env, video.file);
  if (!url?.startsWith('https://')) return refuse(c, 403);
  return c.json({ kind: 'file', title: video.title, description: video.description, url });
});
mountLearningRoutes(nativeLearningRoutes, c => {
  const authorization = c.get("nativeLearningAuthorization");
  return Promise.resolve(authorization ?? { error: refuse(c, 401) });
}, refuse);

// Compatibility name for existing integrations/tests.
export { nativeLearningRoutes as moodleNativeRoutes };
