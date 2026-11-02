import type pg from 'pg';
import type { QaQuestion, QaReply, RpcInputMap, RpcOutputMap } from '@videoq/trpc';
import { withClient } from '../../db/pool';
import { ApiError, apiNotFound } from '../../shared/errors';
import { toUtcIso } from '../../shared/datetime';
import type { Bindings } from '../../types/bindings';

type Access = { courseId: number; shareSlug?: string };
type Course = { id: string; user_id: string; share_slug: string | null };
type Actor = { ownerId: string; userId: string | null; owner: boolean };
type DbQuestion = Omit<QaQuestion, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date };
type DbReply = Omit<QaReply, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date };
const dates = <T extends { createdAt: Date; updatedAt: Date }>(row: T) => ({ ...row, createdAt: toUtcIso(row.createdAt), updatedAt: toUtcIso(row.updatedAt) });
const denied = () => new ApiError(403, 'FORBIDDEN', 'You cannot change this post.');

/** Authorize and read/write on one connection. Course/share revocation and
 * membership removal cannot race a transaction that already checked access. */
async function withCourse<T>(env: Bindings, access: Access, userId: string | null,
  operation: (client: pg.Client, actor: Actor) => Promise<T>): Promise<T> {
  return withClient(env, async client => {
    await client.query('BEGIN');
    try {
      const course = (await client.query<Course>('SELECT id::text, user_id, share_slug FROM video_courses WHERE id=$1 FOR SHARE', [access.courseId])).rows[0];
      if (!course) throw apiNotFound('Course not found');
      const owner = course.user_id === userId;
      if (access.shareSlug !== undefined) {
        if (!course.share_slug || course.share_slug.toLowerCase() !== access.shareSlug.toLowerCase()) throw apiNotFound('Course not found');
      } else if (!owner) {
        if (!userId || !(await client.query('SELECT id FROM video_course_memberships WHERE course_id=$1 AND user_id=$2 FOR SHARE', [access.courseId, userId])).rowCount) throw apiNotFound('Course not found');
      }
      const result = await operation(client, { ownerId: course.user_id, userId, owner });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
// Only username and the instructor badge are public; never expose account emails
// or private AI conversation turns through this explicitly published forum.
const questionFields = `q.id, q.title, q.body, v.id::float8 AS "videoId", v.title AS "videoTitle",
 json_build_object('name',u.username,'instructor',COALESCE(q.author_id=$3,false)) AS author,
 q.created_at AS "createdAt", q.updated_at AS "updatedAt", q.featured,
 (SELECT count(*)::int FROM course_question_replies r WHERE r.question_id=q.id) AS "replyCount",
 (SELECT count(*)::int FROM course_question_votes vote WHERE vote.question_id=q.id) AS votes,
 EXISTS(SELECT 1 FROM course_question_votes vote WHERE vote.question_id=q.id AND vote.user_id=$2) AS voted,
 COALESCE(q.author_id=$2,false) AS "canEdit", COALESCE(q.author_id=$2 OR $4::boolean,false) AS "canDelete"`;
const questionFrom = `FROM course_questions q LEFT JOIN users u ON u.id=q.author_id
 LEFT JOIN videos v ON v.id=q.video_id AND EXISTS(SELECT 1 FROM video_course_members m WHERE m.video_id=v.id AND m.course_id=q.course_id)`;
async function selectQuestion(client: pg.Client, actor: Actor, courseId: number, id: string) {
  const row = (await client.query<DbQuestion>(`SELECT ${questionFields} ${questionFrom} WHERE q.course_id=$1 AND q.id=$5`, [courseId, actor.userId, actor.ownerId, actor.owner, id])).rows[0];
  if (!row) throw apiNotFound('Question not found');
  return dates(row);
}
export function listQuestions(env: Bindings, userId: string | null, input: RpcInputMap['qa.list']): Promise<RpcOutputMap['qa.list']> {
  return withCourse(env, input, userId, async (client, actor) => {
    const filter = `q.course_id=$1 AND ($5::bigint IS NULL OR q.video_id=$5)
      AND ($6='' OR position(lower($6) in lower(q.title||' '||q.body))>0)
      AND (NOT $7::boolean OR NOT EXISTS(SELECT 1 FROM course_question_replies r WHERE r.question_id=q.id))`;
    const args = [input.courseId, userId, actor.ownerId, actor.owner, input.videoId ?? null, input.search, input.unanswered];
    const sort = input.sort === 'votes' ? 'votes DESC, q.created_at DESC' : 'q.created_at DESC';
    const rows = await client.query<DbQuestion>(`SELECT ${questionFields} ${questionFrom} WHERE ${filter}
      ORDER BY q.featured DESC, ${sort}, q.id DESC LIMIT $8 OFFSET $9`, [...args, input.limit, input.offset]);
    const total = (await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM course_questions q
      WHERE q.course_id=$1 AND ($2::bigint IS NULL OR q.video_id=$2)
      AND ($3='' OR position(lower($3) in lower(q.title||' '||q.body))>0)
      AND (NOT $4::boolean OR NOT EXISTS(SELECT 1 FROM course_question_replies r WHERE r.question_id=q.id))`,
      [input.courseId,input.videoId ?? null,input.search,input.unanswered])).rows[0]?.total ?? 0;
    return { items: rows.rows.map(dates), total, canPost: userId !== null, canModerate: actor.owner };
  });
}
export function getQuestion(env: Bindings, userId: string | null, input: RpcInputMap['qa.get']): Promise<RpcOutputMap['qa.get']> {
  return withCourse(env, input, userId, async (client, actor) => {
    const question = await selectQuestion(client, actor, input.courseId, input.questionId);
    const rows = await client.query<DbReply>(`SELECT r.id,r.body,
      json_build_object('name',u.username,'instructor',COALESCE(r.author_id=$3,false)) AS author,
      r.created_at AS "createdAt",r.updated_at AS "updatedAt",
      COALESCE(r.author_id=$2,false) AS "canEdit",COALESCE(r.author_id=$2 OR $4::boolean,false) AS "canDelete"
      FROM course_question_replies r LEFT JOIN users u ON u.id=r.author_id WHERE r.question_id=$1
      ORDER BY r.created_at,r.id LIMIT $5 OFFSET $6`, [input.questionId, userId, actor.ownerId, actor.owner, input.limit, input.offset]);
    return { question, replies: rows.rows.map(dates), replyTotal: question.replyCount, canPost: userId !== null, canModerate: actor.owner };
  });
}

type MutationName = Exclude<Extract<keyof RpcInputMap, `qa.${string}`>, 'qa.get' | 'qa.list'>;
export type QaCommand = { [Name in MutationName]: { name: Name; input: RpcInputMap[Name] } }[MutationName];
export function mutate(env: Bindings, userId: string, command: QaCommand): Promise<{ id: string } | { success: true }> {
  return withCourse(env, command.input, userId, async (client, actor) => {
    const { name, input } = command;
    if (name === 'qa.ask') {
      if (input.videoId !== null && !(await client.query('SELECT id FROM video_course_members WHERE course_id=$1 AND video_id=$2 FOR SHARE', [input.courseId, input.videoId])).rowCount) throw apiNotFound('Video not found in this course');
      const result = await client.query<{ id: string }>('INSERT INTO course_questions(course_id,video_id,author_id,title,body) VALUES($1,$2,$3,$4,$5) RETURNING id', [input.courseId,input.videoId,userId,input.title,input.body]);
      return { id: result.rows[0].id };
    }
    const question = (await client.query<{ author_id: string | null }>('SELECT author_id FROM course_questions WHERE id=$1 AND course_id=$2 FOR UPDATE', [input.questionId,input.courseId])).rows[0];
    if (!question) throw apiNotFound('Question not found');
    if (name === 'qa.updateQuestion') {
      if (question.author_id !== userId) throw denied();
      await client.query('UPDATE course_questions SET title=$2,body=$3,updated_at=now() WHERE id=$1', [input.questionId,input.title,input.body]);
    } else if (name === 'qa.deleteQuestion') {
      if (question.author_id !== userId && !actor.owner) throw denied();
      await client.query('DELETE FROM course_questions WHERE id=$1', [input.questionId]);
    } else if (name === 'qa.reply') {
      const result = await client.query<{ id: string }>('INSERT INTO course_question_replies(question_id,author_id,body) VALUES($1,$2,$3) RETURNING id', [input.questionId,userId,input.body]);
      await client.query('UPDATE course_questions SET updated_at=now() WHERE id=$1', [input.questionId]);
      return { id: result.rows[0].id };
    } else if (name === 'qa.updateReply' || name === 'qa.deleteReply') {
      const reply = (await client.query<{ author_id: string | null }>('SELECT author_id FROM course_question_replies WHERE id=$1 AND question_id=$2 FOR UPDATE', [input.replyId,input.questionId])).rows[0];
      if (!reply) throw apiNotFound('Reply not found');
      if (reply.author_id !== userId && !(name === 'qa.deleteReply' && actor.owner)) throw denied();
      if (name === 'qa.updateReply') await client.query('UPDATE course_question_replies SET body=$2,updated_at=now() WHERE id=$1', [input.replyId,input.body]);
      else await client.query('DELETE FROM course_question_replies WHERE id=$1', [input.replyId]);
      await client.query('UPDATE course_questions SET updated_at=now() WHERE id=$1', [input.questionId]);
    } else if (name === 'qa.vote') {
      if (input.voted) await client.query('INSERT INTO course_question_votes(question_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [input.questionId,userId]);
      else await client.query('DELETE FROM course_question_votes WHERE question_id=$1 AND user_id=$2', [input.questionId,userId]);
    } else if (name === 'qa.feature') {
      if (!actor.owner) throw denied();
      await client.query('UPDATE course_questions SET featured=$2 WHERE id=$1', [input.questionId,input.featured]);
    }
    return { success: true };
  });
}
