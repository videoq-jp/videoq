import type pg from "pg";
import type { QaQuestion, QaReply, RpcInputMap, RpcOutputMap } from "@videoq/trpc";
import { withClient } from "../../db/pool";
import { ApiError, apiNotFound } from "../../shared/errors";
import { toUtcIso } from "../../shared/datetime";
import type { Bindings } from "../../types/bindings";
import { lockLtiDataSession, type LtiSessionProof } from '../lti/data-lock';

/** Internal grant, constructed only after a fresh LMS authorization check. */
export type LtiQaPrincipal = {
  kind: "lti"; courseId: number; ownerUserId: string; authorId: string; videoIds: readonly number[];
  sessionProof?: LtiSessionProof;
  permissions: { view: boolean; post: boolean; vote: boolean; deleteOwn: boolean; moderate: boolean; instructor: boolean };
};
type Principal = string | null | LtiQaPrincipal;
type Access = { courseId: number; shareSlug?: string };
type Actor = { ownerId: string; userId: string | null; ltiId: string | null; videoIds?: number[];
  canPost: boolean; canVote: boolean; canDeleteOwn: boolean; canModerate: boolean; instructor: boolean };
type DbQuestion = Omit<QaQuestion, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
type DbReply = Omit<QaReply, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
const dates = <T extends { createdAt: Date; updatedAt: Date }>(row: T) => ({ ...row, createdAt: toUtcIso(row.createdAt), updatedAt: toUtcIso(row.updatedAt) });
const forbidden = () => new ApiError(403, "FORBIDDEN", "You cannot perform this Q&A operation.");

class Parameters {
  values: unknown[] = [];
  add(value: unknown) { this.values.push(value); return "$" + this.values.length; }
}

/** Keep native membership/share authorization and externally scoped actors on the
 * same transaction. The external actor is never the account owner. */
async function withCourse<T>(env: Bindings, access: Access, principal: Principal,
  operation: (client: pg.Client, actor: Actor) => Promise<T>): Promise<T> {
  return withClient(env, async client => {
    await client.query("BEGIN");
    try {
      if (typeof principal === 'object' && principal !== null)
        await lockLtiDataSession(client,principal.ownerUserId,principal.sessionProof);
      const course = (await client.query<{ user_id: string; share_slug: string | null; managed_by_lms: boolean; native_access_disabled: boolean }>(
        "SELECT user_id,share_slug,managed_by_lms,native_access_disabled FROM video_courses WHERE id=$1 FOR SHARE", [access.courseId])).rows[0];
      if (!course) throw apiNotFound("Course not found");
      let actor: Actor;
      if (typeof principal === "object" && principal !== null) {
        if (principal.kind !== "lti" || principal.courseId !== access.courseId || principal.ownerUserId !== course.user_id
          || !principal.permissions.view || access.shareSlug !== undefined || !/^[a-f0-9]{64}$/.test(principal.authorId)
          || principal.videoIds.length > 1000) throw apiNotFound("Course not found");
        const members = await client.query<{ id: number }>(`SELECT m.video_id::float8 AS id FROM video_course_members m
          JOIN videos v ON v.id=m.video_id WHERE m.course_id=$1 AND v.user_id=$2 AND m.video_id=ANY($3::bigint[])
          FOR SHARE OF m,v`, [access.courseId, course.user_id, principal.videoIds]);
        if (principal.videoIds.length && !members.rowCount) throw apiNotFound("Course not found");
        // [] remains a scoped actor: visibleQuestion hides every source-bound post.
        actor = { ownerId: course.user_id, userId: null, ltiId: principal.authorId, videoIds: members.rows.map(row => row.id),
          canPost: principal.permissions.post, canVote: principal.permissions.vote, canDeleteOwn: principal.permissions.deleteOwn,
          canModerate: principal.permissions.moderate, instructor: principal.permissions.instructor };
      } else {
        const owner = course.user_id === principal;
        // LMS-managed forums use LMS enrolment/visibility. A native invitation
        // or public share does not grant another learner access to this forum.
        // The independently authenticated data owner retains operator access.
        if (!owner || access.shareSlug !== undefined) {
          const protectedVideo = await client.query(`SELECT 1 FROM video_course_members m
            JOIN videos v ON v.id=m.video_id WHERE m.course_id=$1 AND v.managed_by_lms=true LIMIT 1`, [access.courseId]);
          if (course.managed_by_lms || course.native_access_disabled || protectedVideo.rowCount) throw apiNotFound("Course not found");
        }
        if (access.shareSlug !== undefined) {
          if (!course.share_slug || course.share_slug.toLowerCase() !== access.shareSlug.toLowerCase()) throw apiNotFound("Course not found");
        } else if (!owner && (!principal || !(await client.query(
          "SELECT id FROM video_course_memberships WHERE course_id=$1 AND user_id=$2 FOR SHARE", [access.courseId, principal])).rowCount)) {
          throw apiNotFound("Course not found");
        }
        actor = { ownerId: course.user_id, userId: principal, ltiId: null, canPost: principal !== null,
          canVote: principal !== null, canDeleteOwn: principal !== null, canModerate: owner, instructor: false };
      }
      const result = await operation(client, actor);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}

function visibleQuestion(actor: Actor, p: Parameters, courseId: number) {
  let filter = `q.course_id=${p.add(courseId)}`;
  if (actor.videoIds) {
    const ids = p.add(actor.videoIds);
    filter += ` AND (q.source_video_id IS NULL OR q.source_video_id=ANY(${ids}::bigint[]))
      AND (q.video_id IS NULL OR q.video_id=ANY(${ids}::bigint[]))`;
  }
  return filter;
}
function ownExpression(alias: "q" | "r", actor: Actor, p: Parameters) {
  return `COALESCE(${alias}.author_id=${p.add(actor.userId)}::text OR ${alias}.lti_author_id=${p.add(actor.ltiId)}::varchar,false)`;
}
function authorFields(alias: "q" | "r", actor: Actor, p: Parameters) {
  return `json_build_object('name',CASE WHEN ${alias}.lti_author_id=repeat('0',64) THEN 'Deleted participant' WHEN ${alias}.lti_author_id IS NOT NULL THEN left(${alias}.lti_author_id,12) ELSE u.username END,
    'source',CASE WHEN ${alias}.lti_author_id IS NOT NULL THEN 'moodle' ELSE 'videoq' END,
    'instructor',CASE WHEN ${alias}.lti_author_id IS NOT NULL THEN ${alias}.lti_instructor ELSE COALESCE(${alias}.author_id=${p.add(actor.ownerId)}::text,false) END) AS author`;
}
function questionFields(actor: Actor, p: Parameters) {
  const own = ownExpression("q", actor, p);
  return `q.id,q.title,q.body,v.id::float8 AS "videoId",v.title AS "videoTitle",${authorFields("q", actor, p)},
    q.created_at AS "createdAt",q.updated_at AS "updatedAt",q.featured,
    (SELECT count(*)::int FROM course_question_replies r WHERE r.question_id=q.id) AS "replyCount",
    ((SELECT count(*) FROM course_question_votes vote WHERE vote.question_id=q.id)
      +(SELECT count(*) FROM course_question_lti_votes vote WHERE vote.question_id=q.id))::int AS votes,
    (EXISTS(SELECT 1 FROM course_question_votes vote WHERE vote.question_id=q.id AND vote.user_id=${p.add(actor.userId)}::text)
      OR EXISTS(SELECT 1 FROM course_question_lti_votes vote WHERE vote.question_id=q.id AND vote.lti_author_id=${p.add(actor.ltiId)}::varchar)) AS voted,
    (${own} AND ${p.add(actor.canPost)}::boolean) AS "canEdit",(${own} AND ${p.add(actor.canDeleteOwn)}::boolean OR ${p.add(actor.canModerate)}::boolean) AS "canDelete"`;
}
const questionFrom = `FROM course_questions q LEFT JOIN users u ON u.id=q.author_id
  LEFT JOIN videos v ON v.id=q.video_id AND EXISTS(SELECT 1 FROM video_course_members m WHERE m.video_id=v.id AND m.course_id=q.course_id)`;
async function selectQuestion(client: pg.Client, actor: Actor, courseId: number, id: string) {
  const p = new Parameters(), fields = questionFields(actor, p);
  const where = visibleQuestion(actor, p, courseId) + ` AND q.id=${p.add(id)}`;
  const row = (await client.query<DbQuestion>(`SELECT ${fields} ${questionFrom} WHERE ${where}`, p.values)).rows[0];
  if (!row) throw apiNotFound("Question not found");
  return dates(row);
}
const abilities = (actor: Actor) => ({ canPost: actor.canPost, canVote: actor.canVote, canModerate: actor.canModerate });

export function listQuestions(env: Bindings, principal: Principal, input: RpcInputMap["qa.list"]): Promise<RpcOutputMap["qa.list"]> {
  return withCourse(env, input, principal, async (client, actor) => {
    const filter = (p: Parameters) => visibleQuestion(actor, p, input.courseId)
      + ` AND (${p.add(input.videoId ?? null)}::bigint IS NULL OR q.video_id=${p.add(input.videoId ?? null)})
      AND (${p.add(input.search)}='' OR position(lower(${p.add(input.search)}) in lower(q.title||' '||q.body))>0)
      AND (NOT ${p.add(input.unanswered)}::boolean OR NOT EXISTS(SELECT 1 FROM course_question_replies r WHERE r.question_id=q.id))`;
    const p = new Parameters(), fields = questionFields(actor, p), where = filter(p);
    const sort = input.sort === "votes" ? "votes DESC,q.created_at DESC" : "q.created_at DESC";
    const rows = await client.query<DbQuestion>(`SELECT ${fields} ${questionFrom} WHERE ${where}
      ORDER BY q.featured DESC,${sort},q.id DESC LIMIT ${p.add(input.limit)} OFFSET ${p.add(input.offset)}`, p.values);
    const totalParameters = new Parameters();
    const total = (await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM course_questions q WHERE ${filter(totalParameters)}`,
      totalParameters.values)).rows[0]?.total ?? 0;
    return { items: rows.rows.map(dates), total, ...abilities(actor) };
  });
}
export function getQuestion(env: Bindings, principal: Principal, input: RpcInputMap["qa.get"]): Promise<RpcOutputMap["qa.get"]> {
  return withCourse(env, input, principal, async (client, actor) => {
    const question = await selectQuestion(client, actor, input.courseId, input.questionId);
    const p = new Parameters(), own = ownExpression("r", actor, p);
    const rows = await client.query<DbReply>(`SELECT r.id,r.body,${authorFields("r", actor, p)},
      r.created_at AS "createdAt",r.updated_at AS "updatedAt",(${own} AND ${p.add(actor.canPost)}::boolean) AS "canEdit",
      (${own} AND ${p.add(actor.canDeleteOwn)}::boolean OR ${p.add(actor.canModerate)}::boolean) AS "canDelete"
      FROM course_question_replies r LEFT JOIN users u ON u.id=r.author_id WHERE r.question_id=${p.add(input.questionId)}
      ORDER BY r.created_at,r.id LIMIT ${p.add(input.limit)} OFFSET ${p.add(input.offset)}`, p.values);
    return { question, replies: rows.rows.map(dates), replyTotal: question.replyCount, ...abilities(actor) };
  });
}

type MutationName = Exclude<Extract<keyof RpcInputMap, `qa.${string}`>, "qa.get" | "qa.list">;
export type QaCommand = { [Name in MutationName]: { name: Name; input: RpcInputMap[Name] } }[MutationName];
type AuthorRecord = { author_id: string | null; lti_author_id: string | null };
const isOwn = (actor: Actor, row: AuthorRecord) => (actor.userId !== null && actor.userId === row.author_id)
  || (actor.ltiId !== null && actor.ltiId === row.lti_author_id);
async function audit(client: pg.Client, actor: Actor, courseId: number, questionId: string, action: string, replyId: string | null = null) {
  await client.query(`INSERT INTO course_qa_moderation(course_id,question_id,reply_id,actor_user_id,lti_actor_id,action)
    VALUES($1,$2,$3,$4,$5,$6)`, [courseId, questionId, replyId, actor.userId, actor.ltiId, action]);
}
export function mutate(env: Bindings, principal: Exclude<Principal, null>, command: QaCommand): Promise<{ id: string } | { success: true }> {
  return withCourse(env, command.input, principal, async (client, actor) => {
    const { name, input } = command;
    if (name === "qa.ask") {
      if (!actor.canPost) throw forbidden();
      if (input.videoId !== null && ((actor.videoIds && !actor.videoIds.includes(input.videoId)) || !(await client.query(
        "SELECT id FROM video_course_members WHERE course_id=$1 AND video_id=$2 FOR SHARE", [input.courseId, input.videoId])).rowCount)) {
        throw apiNotFound("Video not found in this course");
      }
      const result = await client.query<{ id: string }>(`INSERT INTO course_questions(course_id,video_id,source_video_id,author_id,lti_author_id,lti_instructor,title,body)
        VALUES($1,$2,$2,$3,$4,$5,$6,$7) RETURNING id`, [input.courseId, input.videoId, actor.userId, actor.ltiId, actor.instructor, input.title, input.body]);
      return { id: result.rows[0].id };
    }
    const p = new Parameters(), where = visibleQuestion(actor, p, input.courseId) + ` AND q.id=${p.add(input.questionId)}`;
    const question = (await client.query<AuthorRecord & { featured: boolean }>(
      `SELECT q.author_id,q.lti_author_id,q.featured FROM course_questions q WHERE ${where} FOR UPDATE`, p.values)).rows[0];
    if (!question) throw apiNotFound("Question not found");
    if (name === "qa.updateQuestion") {
      if (!isOwn(actor, question) || !actor.canPost) throw forbidden();
      await client.query("UPDATE course_questions SET title=$2,body=$3,lti_instructor=$4,updated_at=now() WHERE id=$1",
        [input.questionId, input.title, input.body, actor.instructor]);
    } else if (name === "qa.deleteQuestion") {
      const own = isOwn(actor, question);
      if (!(own && actor.canDeleteOwn) && !actor.canModerate) throw forbidden();
      await client.query("DELETE FROM course_questions WHERE id=$1", [input.questionId]);
      if (!own) await audit(client, actor, input.courseId, input.questionId, "delete_question");
    } else if (name === "qa.reply") {
      if (!actor.canPost) throw forbidden();
      const result = await client.query<{ id: string }>(`INSERT INTO course_question_replies(question_id,author_id,lti_author_id,lti_instructor,body)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [input.questionId, actor.userId, actor.ltiId, actor.instructor, input.body]);
      await client.query("UPDATE course_questions SET updated_at=now() WHERE id=$1", [input.questionId]);
      return { id: result.rows[0].id };
    } else if (name === "qa.updateReply" || name === "qa.deleteReply") {
      const reply = (await client.query<AuthorRecord>(
        "SELECT author_id,lti_author_id FROM course_question_replies WHERE id=$1 AND question_id=$2 FOR UPDATE", [input.replyId, input.questionId])).rows[0];
      if (!reply) throw apiNotFound("Reply not found");
      const own = isOwn(actor, reply);
      if (name === "qa.updateReply") {
        if (!own || !actor.canPost) throw forbidden();
        await client.query("UPDATE course_question_replies SET body=$2,lti_instructor=$3,updated_at=now() WHERE id=$1", [input.replyId, input.body, actor.instructor]);
      } else {
        if (!(own && actor.canDeleteOwn) && !actor.canModerate) throw forbidden();
        await client.query("DELETE FROM course_question_replies WHERE id=$1", [input.replyId]);
        if (!own) await audit(client, actor, input.courseId, input.questionId, "delete_reply", input.replyId);
      }
      await client.query("UPDATE course_questions SET updated_at=now() WHERE id=$1", [input.questionId]);
    } else if (name === "qa.vote") {
      if (!actor.canVote) throw forbidden();
      if (actor.ltiId) {
        if (input.voted) await client.query("INSERT INTO course_question_lti_votes(question_id,lti_author_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [input.questionId, actor.ltiId]);
        else await client.query("DELETE FROM course_question_lti_votes WHERE question_id=$1 AND lti_author_id=$2", [input.questionId, actor.ltiId]);
      } else {
        if (input.voted) await client.query("INSERT INTO course_question_votes(question_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [input.questionId, actor.userId]);
        else await client.query("DELETE FROM course_question_votes WHERE question_id=$1 AND user_id=$2", [input.questionId, actor.userId]);
      }
    } else if (name === "qa.feature") {
      if (!actor.canModerate) throw forbidden();
      if (question.featured !== input.featured) {
        await client.query("UPDATE course_questions SET featured=$2 WHERE id=$1", [input.questionId, input.featured]);
        await audit(client, actor, input.courseId, input.questionId, input.featured ? "feature" : "unfeature");
      }
    }
    return { success: true };
  });
}
