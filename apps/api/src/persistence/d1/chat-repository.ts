import { and, or, eq, gt, exists, desc, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, prepareD1Query } from "../../db/d1/query-builders";
import {
  chatLogs as logs,
  videoCourses as courses,
  videoCourseMembers as members,
  videoCourseMemberships as memberships,
  users,
  ltiCredentials as credentials,
  ltiChatLogSubjects as subjects,
  mutationReceipts as receipts,
  chatConversations,
} from "../../db/schema/sqlite";
import { nativeCourseAccessAllowed } from "../../application/native-course-access";
import { nativeCourseDrizzleLogic } from "../native-course-policy-sql";
import { activeD1LmsOwner } from "./lms-owner-policy";
import { chatAnswerSchema, chatAnswerText } from "@videoq/trpc/chat";
import type {
  ChatRepository,
  ChatLogItem,
  ChatQuestionAuthor,
  CreateChatLogInput,
} from "../contracts/chat-repository";
import { checkedLtiSubject } from "../../features/lti/identity";
import { toUtcIso } from "../../shared/datetime";
import { nativeCourseExternalAccess } from "./course-access";
const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z'`;
type LogRow = {
  id: number;
  course_id: number;
  user_id: string;
  username: string | null;
  email: string | null;
  question: string;
  response: string;
  is_shared_origin: number;
  feedback: string | null;
  created_at: string;
  classroom_author: string | null;
};
const author = (r: LogRow): ChatQuestionAuthor | null =>
  r.classroom_author !== null
    ? (JSON.parse(r.classroom_author) as ChatQuestionAuthor)
    : r.is_shared_origin || r.username === null || r.email === null
      ? null
      : { user_id: r.user_id, username: r.username, email: r.email };
const feedback = (value: unknown) =>
  value === "good" || value === "bad" ? value : null;
const logItem = (r: LogRow): ChatLogItem => ({
  id: r.id,
  course: r.course_id,
  asked_by: author(r),
  question: r.question,
  answer: chatAnswerSchema.parse(JSON.parse(r.response)),
  is_shared_origin: Boolean(r.is_shared_origin),
  feedback: feedback(r.feedback),
  created_at: toUtcIso(r.created_at),
});
const projection = {
  id: logs.id,
  course_id: logs.courseId,
  user_id: logs.userId,
  username: users.username,
  email: users.email,
  question: logs.question,
  response: sql<string>`${logs.response}`,
  is_shared_origin: sql<number>`${logs.isSharedOrigin}`,
  feedback: logs.feedback,
  created_at: logs.createdAt,
  classroom_author: sql<string | null>`${subjects.classroomAuthor}`,
};
export function d1ChatLogStatements(
  database: D1Database,
  params: CreateChatLogInput,
  token: string,
  guard: SQL = sql`1`,
) {
  const db = createD1Connection(database),
    c = alias(credentials, "chat_session");
  const answer = chatAnswerSchema.parse(params.answer),
    subject = params.ltiSubject
      ? checkedLtiSubject(params.ltiSubject)
      : undefined;
  if (subject && !params.isShared)
    throw new Error("LTI attribution requires an external course grant");
  const proof = subject?.sessionProof;
  const permission = proof
    ? exists(
        db
          .select({ id: users.id })
          .from(users)
          .innerJoin(c, eq(c.id, proof.sessionHash))
          .where(
            and(
              eq(users.id, params.userId),
              eq(c.kind, "session"),
              sql`julianday(${c.expiresAt})>julianday('now')`,
              eq(
                sql`json_extract(${c.payload},'$.registrationId')`,
                proof.registrationId,
              ),
              eq(
                sql`json_extract(${c.payload},'$.subjectHash')`,
                proof.subjectHash,
              ),
            ),
          ),
      )
    : sql`1`;
  const statements = [
    db.insert(logs).select(
      db
        .select(
          insertSelectFields(logs, {
            userId: sql`${params.userId}`,
            courseId: sql`${params.courseId}`,
            question: sql`${params.question}`,
            response: sql`${JSON.stringify(answer)}`,
            retrievedContexts: sql`${JSON.stringify(params.retrievedContexts)}`,
            isSharedOrigin: sql`${Number(params.isShared)}`,
            feedback: sql`NULL`,
            createdAt: now,
          }),
        )
        .from(sql`(VALUES(1)) input`)
        .where(and(permission, guard)),
    ),
    db.insert(receipts).select(
      db
        .select(
          insertSelectFields(receipts, {
            token: sql`${token}`,
            kind: sql`'chat_create'`,
            resourceId: sql`last_insert_rowid()`,
          }),
        )
        .from(sql`(VALUES(1)) input`)
        .where(sql`changes()=1`),
    ),
  ].map((q) => prepareD1Query(database, q));
  if (subject) {
    const provenance = and(
      eq(
        sql`CAST(json_extract(${c.payload},'$.courseId') AS TEXT)`,
        String(params.courseId),
      ),
      sql`json_extract(${c.payload},'$.registrationId') LIKE 'db:%'`,
    );
    statements.push(
      prepareD1Query(
        database,
        db.insert(subjects).select(
          db
            .select(
              insertSelectFields(subjects, {
                chatLogId: receipts.resourceId,
                subjectKey: sql`${subject.subjectKey}`,
                resourceVideoIds: sql`${JSON.stringify(subject.resourceVideoIds)}`,
                registrationId: sql`CASE WHEN ${provenance} THEN json_extract(${c.payload},'$.registrationId') END`,
                contextId: sql`CASE WHEN ${provenance} THEN json_extract(${c.payload},'$.contextId') END`,
                classroomAuthor: sql`CASE WHEN json_extract(${c.payload},'$.transport')='classroom' AND CAST(json_extract(${c.payload},'$.courseId') AS TEXT)=${String(params.courseId)} THEN ${c.payload} -> '$.classroomAuthor' WHEN json_extract(${c.payload},'$.transport')='native' AND CAST(json_extract(${c.payload},'$.courseId') AS TEXT)=${String(params.courseId)} THEN ${c.payload} -> '$.moodleAuthor' END`,
              }),
            )
            .from(receipts)
            .leftJoin(c, eq(c.id, sql`${proof?.sessionHash ?? null}`))
            .where(eq(receipts.token, token)),
        ),
      ),
    );
  }
  return statements;
}
export function createD1ChatRepository(database: D1Database): ChatRepository {
  const db = createD1Connection(database),
    native = nativeCourseExternalAccess();
  const gate = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  const owned = (courseId: number, userId: string) =>
    and(eq(courses.id, courseId), eq(courses.userId, userId));
  const logQuery = () =>
    db
      .select(projection)
      .from(logs)
      .innerJoin(courses, eq(courses.id, logs.courseId))
      .leftJoin(users, eq(users.id, logs.userId))
      .leftJoin(subjects, eq(subjects.chatLogId, logs.id));
  return {
    async context(params) {
      const lti = params.ltiCourseGrant === params.courseId;
      if (!lti && !params.shareToken && !params.userId) return null;
      const permission = lti
        ? exists(
            db
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.id, courses.userId), activeD1LmsOwner())),
          )
        : params.shareToken
          ? and(eq(courses.shareSlug, params.shareToken), native)!
          : nativeCourseAccessAllowed(
              false,
              {
                owner: eq(courses.userId, sql`${params.userId ?? null}`),
                nativeEnabled: native,
                participant: exists(
                  db
                    .select({ id: memberships.id })
                    .from(memberships)
                    .where(
                      and(
                        eq(memberships.courseId, courses.id),
                        eq(memberships.userId, sql`${params.userId ?? null}`),
                      ),
                    ),
                ),
                shareMatches: sql`0`,
              },
              nativeCourseDrizzleLogic,
            );
      const result = await db.batch([
        db
          .select({ id: courses.id, userId: courses.userId })
          .from(courses)
          .where(and(eq(courses.id, params.courseId), permission)),
        db
          .select({ videoId: members.videoId })
          .from(members)
          .innerJoin(courses, eq(courses.id, members.courseId))
          .where(and(eq(courses.id, params.courseId), permission))
          .orderBy(members.order, members.id),
      ]);
      const course = result[0][0];
      return course
        ? {
            ...course,
            memberVideoIds: result[1]
              .map((r) => r.videoId)
              .filter(
                (id) =>
                  !lti ||
                  params.ltiVideoGrant === undefined ||
                  params.ltiVideoGrant.includes(id),
              ),
          }
        : null;
    },
    async create(params) {
      const token = crypto.randomUUID(),
        statements = d1ChatLogStatements(database, params, token);
      statements.push(
        prepareD1Query(
          database,
          db
            .select({ id: logs.id, feedback: logs.feedback })
            .from(logs)
            .innerJoin(receipts, eq(receipts.resourceId, logs.id))
            .where(eq(receipts.token, token)),
        ),
        prepareD1Query(
          database,
          db.delete(receipts).where(eq(receipts.token, token)),
        ),
      );
      const result = await database.batch<{
          id: number;
          feedback: string | null;
        }>(statements),
        row = result[result.length - 2].results[0];
      if (!row) throw new Error("Missing attributed chat log");
      return { id: row.id, feedback: feedback(row.feedback) };
    },
    async deleteHistory(courseId, userId) {
      const token = crypto.randomUUID();
      const result = await db.batch([
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'chat_delete'`,
                resourceId: courses.id,
              }),
            )
            .from(courses)
            .where(owned(courseId, userId)),
        ),
        db
          .delete(chatConversations)
          .where(and(eq(chatConversations.courseId, courseId), gate(token))),
        db.delete(logs).where(and(eq(logs.courseId, courseId), gate(token))),
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(eq(receipts.token, token)),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      return result[3].length ? { ok: true } : { notFound: true };
    },
    async exportPage(courseId, userId, cursor) {
      const rows = await logQuery()
        .where(
          and(
            owned(courseId, userId),
            cursor
              ? or(
                  gt(logs.createdAt, cursor.createdAt),
                  and(
                    eq(logs.createdAt, cursor.createdAt),
                    gt(logs.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(logs.createdAt, logs.id)
        .limit(100);
      const last = rows.at(-1);
      return {
        rows: rows.map((r) => {
          const answer = chatAnswerSchema.parse(JSON.parse(r.response));
          return {
            created_at: toUtcIso(r.created_at),
            asked_by: author(r),
            question: r.question,
            answer: chatAnswerText(answer),
            is_shared_origin: Boolean(r.is_shared_origin),
            citations: answer.sources,
            feedback: r.feedback,
          };
        }),
        nextCursor:
          rows.length === 100 && last
            ? { createdAt: last.created_at, id: last.id }
            : null,
      };
    },
    async feedback(logId, value, options) {
      const permission =
        options.ltiCourseGrant !== undefined
          ? and(
              eq(logs.courseId, options.ltiCourseGrant),
              eq(logs.isSharedOrigin, true),
            )!
          : options.shareSlug
            ? and(
                eq(courses.shareSlug, options.shareSlug),
                eq(logs.isSharedOrigin, true),
                native,
              )!
            : nativeCourseAccessAllowed(
                false,
                {
                  owner: eq(courses.userId, sql`${options.userId ?? null}`),
                  nativeEnabled: native,
                  participant: eq(logs.userId, sql`${options.userId ?? null}`),
                  shareMatches: sql`0`,
                },
                nativeCourseDrizzleLogic,
              );
      const token = crypto.randomUUID();
      const result = await db.batch([
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'chat_feedback'`,
                resourceId: logs.id,
                effectApplied: sql`coalesce(${permission},0)`,
              }),
            )
            .from(logs)
            .innerJoin(courses, eq(courses.id, logs.courseId))
            .where(eq(logs.id, logId)),
        ),
        db
          .update(logs)
          .set({ feedback: value })
          .where(
            and(
              eq(logs.id, logId),
              exists(
                db
                  .select({ token: receipts.token })
                  .from(receipts)
                  .where(
                    and(
                      eq(receipts.token, token),
                      eq(receipts.effectApplied, true),
                    ),
                  ),
              ),
            ),
          ),
        db
          .select({
            applied: receipts.effectApplied,
            id: logs.id,
            feedback: logs.feedback,
          })
          .from(receipts)
          .leftJoin(logs, eq(logs.id, receipts.resourceId))
          .where(eq(receipts.token, token)),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      const row = result[2][0];
      if (!row || row.id === null) return { notFound: true };
      if (!row.applied) return { forbidden: true };
      return { id: row.id, feedback: feedback(row.feedback) };
    },
    async shareExists(slug) {
      return Boolean(
        await db
          .select({ id: courses.id })
          .from(courses)
          .where(and(eq(courses.shareSlug, slug), native))
          .get(),
      );
    },
    async analytics(courseId, userId) {
      const date = sql<string>`substr(${logs.createdAt},1,10)`;
      const result = await db.batch([
        db
          .select({ id: courses.id })
          .from(courses)
          .where(owned(courseId, userId)),
        db
          .select({
            date: date.as("date"),
            count: sql<number>`count(*)`,
            first: sql<string>`min(${logs.createdAt})`,
            last: sql<string>`max(${logs.createdAt})`,
            good: sql<number>`count(*) FILTER(WHERE ${logs.feedback}='good')`,
            bad: sql<number>`count(*) FILTER(WHERE ${logs.feedback}='bad')`,
            none: sql<number>`count(*) FILTER(WHERE ${logs.feedback} IS NULL)`,
          })
          .from(logs)
          .innerJoin(courses, eq(courses.id, logs.courseId))
          .where(owned(courseId, userId))
          .groupBy(date)
          .orderBy(date),
      ]);
      if (!result[0].length) return { notFound: true };
      const rows = result[1];
      return {
        summary: {
          total_questions: rows.reduce((sum, r) => sum + r.count, 0),
          date_range: {
            first: rows[0] ? toUtcIso(rows[0].first) : null,
            last: rows.at(-1) ? toUtcIso(rows.at(-1)!.last) : null,
          },
        },
        time_series: rows.map((r) => ({ date: r.date, count: r.count })),
        feedback: {
          good: rows.reduce((n, r) => n + r.good, 0),
          bad: rows.reduce((n, r) => n + r.bad, 0),
          none: rows.reduce((n, r) => n + r.none, 0),
        },
      };
    },
    async history(courseId, userId, limit, offset) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new Error("Invalid history pagination");
      const count = db
        .select({ count: sql<number>`count(*)` })
        .from(logs)
        .where(eq(logs.courseId, courses.id));
      const result = await db.batch([
        db
          .select({ count: sql<number>`${count}` })
          .from(courses)
          .where(owned(courseId, userId)),
        logQuery()
          .where(owned(courseId, userId))
          .orderBy(desc(logs.createdAt), desc(logs.id))
          .limit(limit)
          .offset(offset),
      ]);
      const total = result[0][0];
      return total
        ? { count: total.count, results: result[1].map(logItem) }
        : { notFound: true };
    },
  };
}
