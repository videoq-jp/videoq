import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { chatMessagesSchema } from "@videoq/trpc/schema";
import type { AppEnv, Bindings } from "../../types/bindings";
import { toErrorBody } from "../../shared/errors";
import { enforceThrottles, throttledResponse } from "../../lib/rate-limit";
import { getVideoEvidence } from "../../repositories/video-evidence-repository";
import { getCourseWithMembers, updateChatLogFeedback } from "../../repositories/chat-repository";
import { sendChatMessage, streamChatMessage } from "../chat/message-service";
import { courseAccessContext } from "./course-access";
import { appendCourseHistory, readCourseHistory } from "./history";
import { transcriptPage } from "./transcript";
import { mountLtiQa } from "./qa-routes";
import { mountLtiConversations } from "./conversation-routes";
import { mountLtiManagement } from "./management-routes";
import { mountLtiTags } from "./tag-routes";
import { mountLtiReports } from "./report-routes";
import { ltiSubjectKey } from "./identity";
import { ltiSessionProof } from "./data-lock";
import { playbackCueHint } from "./playback-context";
import { digest, randomSecret, readCredential, recordScopeVideos, putLtiFeedback } from "./store";
import type { LearningAuthorization } from "./session-authorization";
import { learningFeatures } from "./session-authorization";

export type LearningRefusal = (c: Context<AppEnv>, status?: 400 | 401 | 403) => Response;
export type LearningAuthorizer = (c: Context<AppEnv>) => Promise<LearningAuthorization | { error: Response }>;
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
const messageSchema = z.object({
  messages: chatMessagesSchema,
  conversationId: z.uuid().optional(),
  resumeConversation: z.boolean().optional(),
  playback: z.object({
    video_id: z.number().int().positive().safe(),
    position_seconds: z.number().min(0).max(604800),
  }).strict().optional(),
}).strict().refine(
  input => input.messages.at(-1)?.role === "user", "The last message must be a question",
).refine(input => !input.conversationId || input.messages.length === 1, 'A saved conversation takes one question')
  .refine(input => !input.resumeConversation || !!input.conversationId, 'A conversation is required');

/** One set of learning operations for browser LTI and Moodle's server API. */
export function mountLearningRoutes(ltiRoutes: Hono<AppEnv>, authorize: LearningAuthorizer, refused: LearningRefusal) {
  const currentContext = (access: LearningAuthorization, env: Bindings) =>
    access.current ? Promise.resolve(access.current) : courseAccessContext(access.reg, access.grant, env);
  async function feedbackReference(c: Context<AppEnv>, sessionHash: string, courseId: number, logId: number | null) {
    if (logId === null) return undefined;
    const id = randomSecret();
    await putLtiFeedback(c.env, await digest(id), sessionHash, courseId, logId);
    return id;
  }

  // Material capabilities come from Moodle on every request, never from LTI roles
  // or browser-supplied course/owner IDs. The VideoQ membership is checked as well.
  async function authorizeCourse(c: Context<AppEnv>) {
    const access = await authorize(c);
    if ("error" in access) return { error: access.error } as const;
    const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + access.grant.subjectHash }]);
    if (denied) return { error: throttledResponse(c, denied) } as const;
    try {
      const current = await currentContext(access, c.env);
      if (!current) return { error: refused(c, 403) } as const;
      const course = access.course ?? await getCourseWithMembers(c.env, { courseId: access.grant.courseId, ltiCourseGrant: access.grant.courseId,
        ltiVideoGrant: [...current.videos, ...(current.managementVideos ?? [])].map(video => video.videoId) });
      if (!course) return { error: refused(c, 403) } as const;
      return { current, course, grant: access.grant, reg: access.reg, sessionHash: access.sessionHash };
    } catch { return { error: refused(c, 403) } as const; }
  }

  async function authorizeMaterials(c: Context<AppEnv>) {
    const access = await authorizeCourse(c);
    if ('error' in access) return access;
    return access.current.videos.length ? access : { error: refused(c, 403) } as const;
  }

  mountLtiQa(ltiRoutes, authorizeCourse, refused);
  mountLtiConversations(ltiRoutes, authorizeCourse, feedbackReference);
  mountLtiManagement(ltiRoutes, authorizeCourse);
  mountLtiTags(ltiRoutes, authorizeCourse);
  mountLtiReports(ltiRoutes, authorizeCourse);

  ltiRoutes.post("/materials", async c => {
    const access = await authorizeCourse(c);
    if ("error" in access) return access.error;
    return c.json({ permissions: access.current.permissions, learningAvailable: access.current.videos.length > 0,
      ...(access.grant.transport === "native" ? { nativeProtocol: 1, features: learningFeatures(access.reg) } : {}),
      order: (access.current.materialOrder ?? [...access.current.videos, ...(access.current.managementVideos ?? [])].map(video => video.videoId))
        .filter(videoId => access.course.memberVideoIds.includes(videoId)),
      videos: access.current.videos.filter(video => access.course.memberVideoIds.includes(video.videoId)),
      managementVideos: (access.current.managementVideos ?? []).filter(video => access.course.memberVideoIds.includes(video.videoId)) });
  });

  ltiRoutes.post("/transcript", async c => {
    const input = z.object({ videoId: z.number().int().positive().safe(), cursor: z.number().int().min(0).max(100_000).default(0),
      limit: z.number().int().min(1).max(100).default(50) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!input.success) return refused(c);
    const access = await authorizeMaterials(c);
    if ("error" in access) return access.error;
    const { videoId, cursor, limit } = input.data;
    const material = access.current.videos.find(video => video.videoId === videoId);
    if (!access.current.permissions.viewTranscript || !material || !access.course.memberVideoIds.includes(videoId)) return refused(c, 403);
    const video = await getVideoEvidence(c.env, { ownerUserId: access.course.userId, videoIds: [videoId] }, videoId);
    if (!video) return refused(c, 403);
    if (video.transcriptTooLarge) return c.json(toErrorBody("VALIDATION_ERROR", "This transcript is too large to display."), 413);
    return c.json({ videoId, title: material.title, ...transcriptPage(video.transcript, cursor, limit) });
  });

  ltiRoutes.post("/history", async c => {
    const access = await authorize(c);
    if ("error" in access) return access.error;
    const { grant, sessionHash } = access;
    const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]);
    if (denied) return throttledResponse(c, denied);
    let allowed;
    try { allowed = (await currentContext(access, c.env))?.videos ?? null; } catch { return refused(c, 403); }
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
    const { grant, sessionHash } = access;
    const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]);
    if (denied) return throttledResponse(c, denied);
    const input = messageSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return refused(c);
    let current;
    try { current = await currentContext(access, c.env); } catch { return refused(c, 403); }
    if (current && !current.videos.length) return refused(c, 403);
    if (input.data.conversationId && !current?.permissions.manageOwnHistory) return refused(c, 403);
    const allowed = current?.videos ?? null;
    const subjectKey = await ltiSubjectKey(grant);
    const conversation = input.data.conversationId ? { conversation_id: input.data.conversationId,
      resume_conversation: input.data.resumeConversation ?? false } : {};
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
        ltiSubjectKey: subjectKey, ltiSessionProof:ltiSessionProof(grant,sessionHash), displayQuestion: input.data.messages.at(-1)!.content,
        body: { messages, course_id: grant.courseId, ...conversation }, locale: grant.locale,
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
              await appendCourseHistory(c.env, {...grant,sessionProof:ltiSessionProof(grant,sessionHash)}, input.data.messages.at(-1)!.content, event.chat_log_id, ltiVideoGrant);
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
      ltiSubjectKey: subjectKey, ltiSessionProof:ltiSessionProof(grant,sessionHash), displayQuestion: input.data.messages.at(-1)!.content,
      body: { messages, course_id: grant.courseId, ...conversation }, locale: grant.locale,
    });
    // Expose a session-bound feedback reference, never owner log IDs.
    if (result.status !== 200 || !("answer" in result.body)) return c.json(result.body, result.status);
    await appendCourseHistory(c.env, {...grant,sessionProof:ltiSessionProof(grant,sessionHash)}, input.data.messages.at(-1)!.content, result.body.chat_log_id ?? null, ltiVideoGrant);
    const feedbackId = await feedbackReference(c, sessionHash, grant.courseId, result.body.chat_log_id ?? null);
    return c.json({ answer: result.body.answer, ...(feedbackId ? { feedbackId, feedback: result.body.feedback ?? null } : {}), ...(allowed ? { videos: allowed } : {}) });
  });


  ltiRoutes.post("/feedback", async c => {
    const access = await authorize(c);
    if ("error" in access) return access.error;
    const input = z.object({ feedbackId: opaque, feedback: z.enum(["good", "bad"]).nullable() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!input.success) return refused(c);
    const { grant, sessionHash } = access;
    const ref = z.object({ sessionHash: z.string(), courseId: z.number().int().positive(), logId: z.number().int().positive() })
      .safeParse(await readCredential(c.env, await digest(input.data.feedbackId), "lti-feedback"));
    if (!ref.success || ref.data.sessionHash !== sessionHash || ref.data.courseId !== grant.courseId) return refused(c, 403);
    try { await currentContext(access, c.env); } catch { return refused(c, 403); }
    if (!await getCourseWithMembers(c.env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId })) return refused(c, 403);
    const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]);
    if (denied) return throttledResponse(c, denied);
    const updated = await updateChatLogFeedback(c.env, ref.data.logId, input.data.feedback, { ltiCourseGrant: grant.courseId });
    if ("notFound" in updated || "forbidden" in updated) return refused(c, 403);
    return c.json({ feedback: updated.feedback });
  });
}
