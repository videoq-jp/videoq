import { historyForCourse, exportHistoryCsv } from '../../integrations/chat-history';
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
import { mountLtiQa } from "./qa-routes";
import { mountLtiConversations } from "./conversation-routes";
import { mountLtiManagement } from "./management-routes";
import { mountLtiTags } from "./tag-routes";
import { mountLtiReports } from "./report-routes";
import { ltiSubjectKey } from "./identity";
import { ltiSessionProof } from "./data-lock";
import { learningMaterials, prepareLearningChat, authorizeLearningCourse, readLearningTranscript,
  issueLearningFeedback, readLearningHistory, updateLearningFeedback, completeLearningChat,
  ownerLearningHistoryAvailable } from "./learning-service";
import { digest, randomSecret, readCredential, recordScopeVideos, putLtiFeedback } from "./store";
import type { LearningAuthorization } from "./session-authorization";

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
    return issueLearningFeedback(logId, {
      newId: randomSecret,
      save: async (id, log) => { await putLtiFeedback(c.env, await digest(id), sessionHash, courseId, log); },
    });
  }

  // Material capabilities come from Moodle on every request, never from LTI roles
  // or browser-supplied course/owner IDs. The VideoQ membership is checked as well.
  async function authorizeCourse(c: Context<AppEnv>) {
    const access = await authorize(c);
    if ("error" in access) return { error: access.error } as const;
    const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + access.grant.subjectHash }]);
    if (denied) return { error: throttledResponse(c, denied) } as const;
    const result = await authorizeLearningCourse(access, {
      current: () => currentContext(access, c.env),
      course: videos => getCourseWithMembers(c.env, { courseId: access.grant.courseId, ltiCourseGrant: access.grant.courseId, ltiVideoGrant: videos }),
    });
    return 'denied' in result ? { error: refused(c, 403) } as const : result;
  }

  function completeAnswer(c: Context<AppEnv>, access: LearningAuthorization, question: string, logId: number | null, videoIds: number[] | undefined) {
    const { grant, sessionHash } = access;
    return completeLearningChat(question, logId, videoIds, {
      append: (text, log, videos) => appendCourseHistory(c.env, { ...grant, sessionProof: ltiSessionProof(grant, sessionHash) }, text, log, videos),
      feedback: log => feedbackReference(c, sessionHash, grant.courseId, log),
    });
  }

  mountLtiQa(ltiRoutes, authorizeCourse, refused);
  mountLtiConversations(ltiRoutes, authorizeCourse, feedbackReference);
  mountLtiManagement(ltiRoutes, authorizeCourse);
  mountLtiTags(ltiRoutes, authorizeCourse);
  mountLtiReports(ltiRoutes, authorizeCourse);

  // Same owner-only history and CSV as the native VideoQ course screen.
  // A Moodle/Classroom teacher role alone never grants another owner's logs.
  ltiRoutes.post('/course-history', async c => {
    const access = await authorizeCourse(c);
    if ('error' in access) return access.error;
    if (!ownerLearningHistoryAvailable(access.current)) return refused(c, 403);
    const input = z.object({ action: z.enum(['list', 'csv']) }).strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return refused(c);
    if (input.data.action === 'csv') {
      const result = await exportHistoryCsv(c.env, access.grant.courseId, access.course.userId);
      if ('notFound' in result) return refused(c, 403);
      return new Response(result.body, { headers: { 'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'private, no-store', 'Content-Disposition': 'attachment; filename="' + result.filename + '"' } });
    }
    const result = await historyForCourse(c.env, access.grant.courseId, access.course.userId, 100, 0);
    return 'notFound' in result ? refused(c, 403) : c.json(result);
  });

  ltiRoutes.post("/materials", async c => {
    const access = await authorizeCourse(c);
    if ("error" in access) return access.error;
    return c.json(learningMaterials(access.current, access.course, access.reg, access.grant));
  });

  ltiRoutes.post("/transcript", async c => {
    const input = z.object({ videoId: z.number().int().positive().safe(), cursor: z.number().int().min(0).max(100_000).default(0),
      limit: z.number().int().min(1).max(100).default(50) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!input.success) return refused(c);
    const access = await authorizeCourse(c);
    if ("error" in access) return access.error;
    const result = await readLearningTranscript(access, input.data, (ownerUserId, videoIds, videoId) =>
      getVideoEvidence(c.env, { ownerUserId, videoIds }, videoId));
    if ('denied' in result) return refused(c, 403);
    if ('tooLarge' in result) return c.json(toErrorBody("VALIDATION_ERROR", "This transcript is too large to display."), 413);
    return c.json(result.page);
  });

  ltiRoutes.post("/history", async c => {
    const access = await authorize(c);
    if ("error" in access) return access.error;
    const { grant, sessionHash } = access;
    const denied = await enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]);
    if (denied) return throttledResponse(c, denied);
    const result = await readLearningHistory(access, {
      current: () => currentContext(access, c.env),
      course: videos => getCourseWithMembers(c.env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId, ltiVideoGrant: videos }),
      turns: (owner, videos) => readCourseHistory(c.env, grant, owner, videos),
      feedback: log => feedbackReference(c, sessionHash, grant.courseId, log),
    });
    return 'denied' in result ? refused(c, 403) : c.json(result);
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
    const prepared = await prepareLearningChat(current, grant, {
      ...input.data,
      playback: input.data.playback ? { videoId: input.data.playback.video_id, seconds: input.data.playback.position_seconds } : undefined,
    }, {
      subjectKey: () => ltiSubjectKey(grant),
      recordScope: videos => recordScopeVideos(c.env, sessionHash, videos),
      course: videos => getCourseWithMembers(c.env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId, ltiVideoGrant: videos }),
      transcript: async (ownerUserId, videoIds, videoId) =>
        (await getVideoEvidence(c.env, { ownerUserId, videoIds }, videoId))?.transcript ?? null,
      validateMessages: messages => {
        const parsed = chatMessagesSchema.safeParse(messages);
        return parsed.success ? parsed.data : null;
      },
    });
    if ('denied' in prepared) return refused(c, prepared.denied === 'expired' ? 401 : prepared.denied === 'invalid' ? 400 : 403);
    const { messages, allowed, ltiVideoGrant, subjectKey, conversation } = prepared;
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
              const feedbackId = await completeAnswer(c, access, input.data.messages.at(-1)!.content, event.chat_log_id, ltiVideoGrant);
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
    const feedbackId = await completeAnswer(c, access, input.data.messages.at(-1)!.content, result.body.chat_log_id ?? null, ltiVideoGrant);
    return c.json({ answer: result.body.answer, ...(feedbackId ? { feedbackId, feedback: result.body.feedback ?? null } : {}), ...(allowed ? { videos: allowed } : {}) });
  });


  ltiRoutes.post("/feedback", async c => {
    const access = await authorize(c);
    if ("error" in access) return access.error;
    const input = z.object({ feedbackId: opaque, feedback: z.enum(["good", "bad"]).nullable() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!input.success) return refused(c);
    const { grant } = access;
    const result = await updateLearningFeedback(access, input.data.feedbackId, input.data.feedback, {
      reference: async id => {
        const parsed = z.object({ sessionHash: z.string(), courseId: z.number().int().positive(), logId: z.number().int().positive() })
          .safeParse(await readCredential(c.env, await digest(id), "lti-feedback"));
        return parsed.success ? parsed.data : null;
      },
      current: () => currentContext(access, c.env),
      course: () => getCourseWithMembers(c.env, { courseId: grant.courseId, ltiCourseGrant: grant.courseId }),
      throttle: () => enforceThrottles(c.env, [{ scope: "chat_authenticated", ident: "lti:" + grant.subjectHash }]),
      update: (logId, feedback) => updateChatLogFeedback(c.env, logId, feedback, { ltiCourseGrant: grant.courseId }),
    });
    if ('denied' in result) return refused(c, 403);
    if ('throttled' in result) return throttledResponse(c, result.throttled);
    return c.json(result);
  });
}
