import { Hono, type Context } from "hono";
import { z } from "zod";
import { qaInputSchemas, qaOutputSchemas } from "@videoq/trpc";
import type { AppEnv } from "../../types/bindings";
import { ApiError, toErrorBody } from "../../shared/errors";
import { getQuestion, listQuestions, mutate, type LtiQaPrincipal } from "../qa/service";
import type { CourseAccess } from "./course-access";
import type { sessionRecord } from "./protocol";
import { digest } from "./store";
import { ltiSessionProof } from './data-lock';

export const ltiQaInput = z.discriminatedUnion("action", [
  qaInputSchemas["qa.list"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("list") }).strict(),
  qaInputSchemas["qa.get"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("get") }).strict(),
  qaInputSchemas["qa.ask"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("ask") }).strict(),
  qaInputSchemas["qa.reply"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("reply") }).strict(),
  qaInputSchemas["qa.updateQuestion"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("updateQuestion") }).strict(),
  qaInputSchemas["qa.deleteQuestion"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("deleteQuestion") }).strict(),
  qaInputSchemas["qa.updateReply"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("updateReply") }).strict(),
  qaInputSchemas["qa.deleteReply"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("deleteReply") }).strict(),
  qaInputSchemas["qa.vote"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("vote") }).strict(),
  qaInputSchemas["qa.feature"].omit({ courseId: true, shareSlug: true }).extend({ action: z.literal("feature") }).strict(),
]);
type AuthorizedCourse = { current: CourseAccess; grant: z.infer<typeof sessionRecord>;
  sessionHash: string;
  course: { userId: string; memberVideoIds: number[] } };
type AuthorizeCourse = (c: Context<AppEnv>) => Promise<AuthorizedCourse | { error: Response }>;
type Refuse = (c: Context<AppEnv>, status?: 400 | 401 | 403) => Response;

/** Browser input never selects an account, course, author, or capability. */
export function mountLtiQa(routes: Hono<AppEnv>, authorize: AuthorizeCourse, refuse: Refuse) {
  routes.post("/qa", async c => {
    const access = await authorize(c);
    if ("error" in access) return access.error;
    const parsed = ltiQaInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return refuse(c);
    const data = parsed.data, permissions = access.current.permissions;
    if (!permissions.viewQa) return refuse(c, 403);
    if (["ask", "reply", "updateQuestion", "updateReply"].includes(data.action) && !permissions.postQa) return refuse(c, 403);
    if (data.action === "vote" && !permissions.voteQa) return refuse(c, 403);
    if (data.action === "feature" && !permissions.moderateQa) return refuse(c, 403);
    if (["deleteQuestion", "deleteReply"].includes(data.action) && !permissions.deleteOwnQa && !permissions.moderateQa) return refuse(c, 403);
    const { grant, course } = access, courseId = grant.courseId;
    const principal: LtiQaPrincipal = { kind: "lti", courseId, ownerUserId: course.userId,
      sessionProof:ltiSessionProof(grant,access.sessionHash),
      authorId: await digest(JSON.stringify(["lti-course-qa-v1", grant.registrationId, grant.subjectHash, courseId])),
      videoIds: access.current.videos.map(video => video.videoId).filter(id => course.memberVideoIds.includes(id)),
      permissions: { view: permissions.viewQa, post: permissions.postQa, vote: permissions.voteQa,
        deleteOwn: permissions.deleteOwnQa, moderate: permissions.moderateQa, instructor: permissions.instructorQa } };
    const result = (body: unknown, schema: z.ZodType) => c.json({ data: schema.parse(body), permissions,
      videos: access.current.videos.filter(video => principal.videoIds.includes(video.videoId)) });
    try {
      switch (data.action) {
        case "list": return result(await listQuestions(c.env, principal, { ...data, courseId }), qaOutputSchemas["qa.list"]);
        case "get": return result(await getQuestion(c.env, principal, { ...data, courseId }), qaOutputSchemas["qa.get"]);
        case "ask": return result(await mutate(c.env, principal, { name: "qa.ask", input: { ...data, courseId } }), qaOutputSchemas["qa.ask"]);
        case "reply": return result(await mutate(c.env, principal, { name: "qa.reply", input: { ...data, courseId } }), qaOutputSchemas["qa.reply"]);
        case "updateQuestion": return result(await mutate(c.env, principal, { name: "qa.updateQuestion", input: { ...data, courseId } }), qaOutputSchemas["qa.updateQuestion"]);
        case "deleteQuestion": return result(await mutate(c.env, principal, { name: "qa.deleteQuestion", input: { ...data, courseId } }), qaOutputSchemas["qa.deleteQuestion"]);
        case "updateReply": return result(await mutate(c.env, principal, { name: "qa.updateReply", input: { ...data, courseId } }), qaOutputSchemas["qa.updateReply"]);
        case "deleteReply": return result(await mutate(c.env, principal, { name: "qa.deleteReply", input: { ...data, courseId } }), qaOutputSchemas["qa.deleteReply"]);
        case "vote": return result(await mutate(c.env, principal, { name: "qa.vote", input: { ...data, courseId } }), qaOutputSchemas["qa.vote"]);
        case "feature": return result(await mutate(c.env, principal, { name: "qa.feature", input: { ...data, courseId } }), qaOutputSchemas["qa.feature"]);
      }
    } catch (error) {
      if (error instanceof ApiError) return c.json(toErrorBody(error.code, error.expose ? error.message : "Course Q&A is unavailable."), error.status);
      console.error(JSON.stringify({ event: "lti_qa_failed", kind: error instanceof z.ZodError ? "response_validation" : "service" }));
      return c.json(toErrorBody("INTERNAL_ERROR", "Course Q&A is unavailable."), 500);
    }
  });
}
