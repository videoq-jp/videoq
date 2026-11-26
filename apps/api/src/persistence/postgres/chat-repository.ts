import { alias } from "drizzle-orm/pg-core";
import { insertSelectValues } from "../../db/postgres/query-builders";
import { nativeCourseAccessAllowed } from "../../domain/learning/native-course-access";
import { nativeCourseDrizzleLogic } from "../native-course-policy-sql";
import { activeLmsOwner } from "./lms-owner-policy";
import { lockLtiDataSessionWithDb } from "./lti-session-lock";
import {
  chatAnswerSchema,
  chatAnswerText,
  type ChatAnswer,
  type ChatSource,
} from "@videoq/trpc/chat";
import { and, asc, desc, eq, gt, or, sql, exists, inArray } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import {
  chatLogs,
  chatConversations,
  ltiCredentials,
  ltiChatLogSubjects,
  users,
  videoCourses,
  videoCourseMembers,
} from "../../db/schema";
import { toUtcIso } from "../../shared/datetime";
import type { Bindings } from "../../types/bindings";
import {
  checkedLtiSubject,
  type LtiDataSubject,
} from "../../features/lti/identity";
import {
  nativeCourseExternalAccess,
  nativeCourseReadableBy,
} from "./course-authority";

type ChatQuestionAuthor = {
  user_id: string;
  username: string;
  email: string;
};

// ChatLog API のレスポンス表現。
export type ChatLogItem = {
  id: number;
  course: number;
  asked_by: ChatQuestionAuthor | null;
  question: string;
  answer: ChatAnswer;
  is_shared_origin: boolean;
  feedback: "good" | "bad" | null;
  created_at: string;
};

/** チャット送信時の講座文脈。 */
export type GroupChatContext = {
  id: number;
  userId: string;
  memberVideoIds: number[];
};

function chatFeedback(value: unknown): "good" | "bad" | null {
  return value === "good" || value === "bad" ? value : null;
}

function mapQuestionAuthor(
  isSharedOrigin: boolean,
  userId: unknown,
  username: unknown,
  email: unknown,
): ChatQuestionAuthor | null {
  if (
    isSharedOrigin ||
    typeof userId !== "string" ||
    typeof username !== "string" ||
    typeof email !== "string"
  ) {
    return null;
  }
  return { user_id: userId, username, email };
}

/**
 * share_token 指定時は share_slug で、
 * それ以外は user_id で絞る。認証条件が無い場合も、見つからない場合も null。
 */
export async function getCourseWithMembers(
  env: Bindings,
  params: {
    courseId: number;
    userId?: string | null;
    shareToken?: string | null;
    ltiCourseGrant?: number;
    ltiVideoGrant?: number[];
  },
): Promise<GroupChatContext | null> {
  // Only verified LMS transports (LTI) may supply this server-side grant.
  const ltiGranted = params.ltiCourseGrant === params.courseId;
  if (!params.shareToken && !params.userId && !ltiGranted) return null;
  return withDb(env, async (db) => {
    const conditions = [eq(videoCourses.id, params.courseId)];
    if (ltiGranted) {
      conditions.push(
        exists(
          db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, videoCourses.userId), activeLmsOwner())),
        ),
      );
    } else if (params.shareToken) {
      conditions.push(
        eq(videoCourses.shareSlug, params.shareToken),
        nativeCourseExternalAccess(),
      );
    } else if (params.userId) {
      conditions.push(nativeCourseReadableBy(params.userId));
    }

    const courses = await db
      .select({
        id: videoCourses.id,
        userId: videoCourses.userId,
      })
      .from(videoCourses)
      .where(and(...conditions))
      .limit(1);
    if (courses.length === 0) return null;

    const members = await db
      .select({ videoId: videoCourseMembers.videoId })
      .from(videoCourseMembers)
      .where(eq(videoCourseMembers.courseId, params.courseId))
      .orderBy(asc(videoCourseMembers.order), asc(videoCourseMembers.id));

    const row = courses[0];
    return {
      id: Number(row.id),
      userId: String(row.userId),
      memberVideoIds: members
        .map((m) => Number(m.videoId))
        .filter(
          (id) =>
            !ltiGranted ||
            params.ltiVideoGrant === undefined ||
            params.ltiVideoGrant.includes(id),
        ),
    };
  });
}

/** Persist the validated answer; AI quality evaluation has been retired. */
export async function createChatLogWithDb(
  db: Db,
  params: {
    userId: string;
    courseId: number;
    question: string;
    answer: ChatAnswer;
    isShared: boolean;
    retrievedContexts: readonly string[];
    ltiSubject?: LtiDataSubject;
  },
): Promise<{ id: number; feedback: string | null }> {
  if (params.ltiSubject) {
    const subject = checkedLtiSubject(params.ltiSubject);
    if (!params.isShared)
      throw new Error("LTI attribution requires an external course grant");
    // Values inserts let PostgreSQL generate both ALWAYS and BY DEFAULT identities.
    // A transaction keeps the log and attribution atomic, including standalone calls.
    return db.transaction(async (tx) => {
      await lockLtiDataSessionWithDb(tx, params.userId, subject.sessionProof);
      const [saved] = await tx
        .insert(chatLogs)
        .values({
          userId: params.userId,
          courseId: params.courseId,
          question: params.question,
          response: chatAnswerSchema.parse(params.answer),
          retrievedContexts: params.retrievedContexts,
          isSharedOrigin: true,
          feedback: null,
          createdAt: sql`now()`,
        })
        .returning({ id: chatLogs.id });
      if (subject.sessionProof) {
        await tx.insert(ltiChatLogSubjects).select(
          tx
            .select(
              insertSelectValues(ltiChatLogSubjects, {
                chatLogId: saved.id,
                subjectKey: subject.subjectKey,
                resourceVideoIds: subject.resourceVideoIds,
                registrationId: sql`CASE WHEN ${ltiCredentials.payload}->>'courseId'=${String(params.courseId)} AND ${ltiCredentials.payload}->>'registrationId' LIKE 'db:%' THEN ${ltiCredentials.payload}->>'registrationId' END`,
                contextId: sql`CASE WHEN ${ltiCredentials.payload}->>'courseId'=${String(params.courseId)} AND ${ltiCredentials.payload}->>'registrationId' LIKE 'db:%' THEN ${ltiCredentials.payload}->>'contextId' END`,
                classroomAuthor: sql`CASE WHEN ${ltiCredentials.payload}->>'transport'='classroom' AND ${ltiCredentials.payload}->>'courseId'=${String(params.courseId)} THEN ${ltiCredentials.payload}->'classroomAuthor'
          WHEN ${ltiCredentials.payload}->>'transport'='native' AND ${ltiCredentials.payload}->>'courseId'=${String(params.courseId)} THEN ${ltiCredentials.payload}->'moodleAuthor' END`,
              }),
            )
            .from(ltiCredentials)
            .where(eq(ltiCredentials.id, subject.sessionProof.sessionHash)),
        );
      } else {
        await tx
          .insert(ltiChatLogSubjects)
          .values({
            chatLogId: saved.id,
            subjectKey: subject.subjectKey,
            resourceVideoIds: subject.resourceVideoIds,
          });
      }
      return { id: Number(saved.id), feedback: null };
    });
  }
  const rows = await db
    .insert(chatLogs)
    .values({
      userId: params.userId,
      courseId: params.courseId,
      question: params.question,
      response: chatAnswerSchema.parse(params.answer),
      retrievedContexts: params.retrievedContexts,
      isSharedOrigin: params.isShared,
      feedback: null,
      createdAt: sql`now()`,
    })
    .returning({ id: chatLogs.id, feedback: chatLogs.feedback });
  const r = rows[0];
  const chatLogId = Number(r.id);
  return {
    id: chatLogId,
    feedback: chatFeedback(r.feedback),
  };
}

export async function createChatLog(
  env: Bindings,
  params: Parameters<typeof createChatLogWithDb>[1],
): Promise<{ id: number; feedback: string | null }> {
  return withDb(env, (db) => createChatLogWithDb(db, params));
}

/**
 * 講座のチャット履歴を全削除する。
 * 評価は ChatLog の ON DELETE CASCADE で削除する。
 */
export async function deleteCourseChatLogs(
  env: Bindings,
  courseId: number,
  userId: string,
): Promise<{ notFound: true } | { ok: true }> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const owner = await tx
        .select({ id: videoCourses.id })
        .from(videoCourses)
        .where(
          and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)),
        )
        .limit(1);
      if (owner.length === 0) return { notFound: true } as const;

      await tx
        .delete(chatConversations)
        .where(eq(chatConversations.courseId, courseId));
      await tx.delete(chatLogs).where(eq(chatLogs.courseId, courseId));
      return { ok: true } as const;
    }),
  );
}

/** CSV エクスポート 1 行分（created_at 昇順）。 */
export type ChatHistoryExportRow = {
  created_at: string; // UTC ISO 8601
  asked_by: ChatQuestionAuthor | null;
  question: string;
  answer: string;
  is_shared_origin: boolean;
  citations: ChatSource[];
  feedback: string | null;
};

type ChatHistoryExportCursor = {
  createdAt: string;
  id: number;
};

const CHAT_HISTORY_EXPORT_PAGE_SIZE = 100;

/** CSV rows are fetched with a stable keyset cursor, never as one unbounded result. */
async function getCourseChatHistoryExportPage(
  env: Bindings,
  courseId: number,
  userId: string,
  cursor: ChatHistoryExportCursor | null,
): Promise<{
  rows: ChatHistoryExportRow[];
  nextCursor: ChatHistoryExportCursor | null;
}> {
  return withDb(env, async (db) => {
    const afterCursor = cursor
      ? or(
          gt(chatLogs.createdAt, cursor.createdAt),
          and(
            eq(chatLogs.createdAt, cursor.createdAt),
            gt(chatLogs.id, cursor.id),
          ),
        )
      : undefined;
    const selected = await db
      .select({
        // Keep PostgreSQL's full timestamp precision for the keyset cursor.
        // node-postgres Date values only retain milliseconds, so selecting the
        // timestamp as text prevents rows within the same millisecond from
        // being repeated or skipped at a page boundary.
        createdAt: sql<string | Date>`${chatLogs.createdAt}::text`,
        userId: chatLogs.userId,
        username: users.username,
        email: users.email,
        question: chatLogs.question,
        answer: chatLogs.response,
        isSharedOrigin: chatLogs.isSharedOrigin,
        feedback: chatLogs.feedback,
        id: chatLogs.id,
        classroomAuthor: ltiChatLogSubjects.classroomAuthor,
      })
      .from(chatLogs)
      .innerJoin(
        videoCourses,
        and(
          eq(videoCourses.id, chatLogs.courseId),
          eq(videoCourses.userId, userId),
        ),
      )
      .leftJoin(users, eq(users.id, chatLogs.userId))
      .leftJoin(
        ltiChatLogSubjects,
        eq(ltiChatLogSubjects.chatLogId, chatLogs.id),
      )
      .where(and(eq(chatLogs.courseId, courseId), afterCursor))
      .orderBy(asc(chatLogs.createdAt), asc(chatLogs.id))
      .limit(CHAT_HISTORY_EXPORT_PAGE_SIZE);

    const last = selected.at(-1);

    return {
      rows: selected.map((row) => {
        const answer = chatAnswerSchema.parse(row.answer);
        return {
          created_at: toUtcIso(row.createdAt),
          asked_by:
            row.classroomAuthor ??
            mapQuestionAuthor(
              row.isSharedOrigin,
              row.userId,
              row.username,
              row.email,
            ),
          question: row.question,
          answer: chatAnswerText(answer),
          is_shared_origin: row.isSharedOrigin,
          citations: answer.sources,
          feedback: row.feedback ?? null,
        };
      }),
      nextCursor:
        selected.length === CHAT_HISTORY_EXPORT_PAGE_SIZE && last
          ? {
              createdAt:
                last.createdAt instanceof Date
                  ? last.createdAt.toISOString()
                  : last.createdAt,
              id: last.id,
            }
          : null,
    };
  });
}

export async function* iterateCourseChatHistoryForExport(
  env: Bindings,
  courseId: number,
  userId: string,
): AsyncGenerator<ChatHistoryExportRow> {
  let cursor: ChatHistoryExportCursor | null = null;
  do {
    const page = await getCourseChatHistoryExportPage(
      env,
      courseId,
      userId,
      cursor,
    );
    for (const row of page.rows) yield row;
    cursor = page.nextCursor;
  } while (cursor);
}

/** Authorize and update feedback in one statement, preserving missing/forbidden results. */
export async function updateChatLogFeedback(
  env: Bindings,
  logId: number,
  feedback: "good" | "bad" | null,
  opts: { userId?: string; shareSlug?: string | null; ltiCourseGrant?: number },
) {
  const log = alias(chatLogs, "feedback_log"),
    course = alias(videoCourses, "feedback_course");
  const permission =
    opts.ltiCourseGrant !== undefined
      ? sql`${log.courseId}=${opts.ltiCourseGrant} AND ${log.isSharedOrigin}=true`
      : opts.shareSlug
        ? sql`${course.shareSlug}=${opts.shareSlug} AND ${log.isSharedOrigin}=true AND ${nativeCourseExternalAccess(course.id, course.managedByLms, course.nativeAccessDisabled)}`
        : nativeCourseAccessAllowed(
            false,
            {
              owner: sql`${course.userId}=${opts.userId ?? null}`,
              participant: sql`${log.userId}=${opts.userId ?? null}`,
              nativeEnabled: nativeCourseExternalAccess(
                course.id,
                course.managedByLms,
                course.nativeAccessDisabled,
              ),
              shareMatches: sql`false`,
            },
            nativeCourseDrizzleLogic,
          );
  return withDb(env, async (db) => {
    const target = db.$with("target").as(
      db
        .select({
          id: log.id,
          allowed: sql<boolean>`COALESCE((${permission}),false)`.as("allowed"),
        })
        .from(log)
        .innerJoin(course, eq(course.id, log.courseId))
        .where(eq(log.id, logId)),
    );
    const updated = db.$with("updated").as(
      db
        .update(chatLogs)
        .set({ feedback })
        .from(target)
        .where(and(eq(chatLogs.id, target.id), target.allowed))
        .returning({ id: chatLogs.id, feedback: chatLogs.feedback }),
    );
    const [row] = await db
      .with(target, updated)
      .select({
        allowed: target.allowed,
        id: updated.id,
        feedback: updated.feedback,
      })
      .from(target)
      .leftJoin(updated, eq(updated.id, target.id));
    if (!row) return { notFound: true } as const;
    if (!row.allowed) return { forbidden: true } as const;
    // A concurrent history reset may delete an authorized row before UPDATE acquires it.
    if (row.id === null) return { notFound: true } as const;
    return { id: Number(row.id), feedback: chatFeedback(row.feedback) };
  });
}

/** share_slug が何らかの講座に解決するか判定する。 */
export async function shareSlugExists(
  env: Bindings,
  shareSlug: string,
): Promise<boolean> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ id: videoCourses.id })
      .from(videoCourses)
      .where(
        and(
          eq(videoCourses.shareSlug, shareSlug),
          nativeCourseExternalAccess(),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

export type ChatAnalytics = {
  summary: {
    total_questions: number;
    date_range: { first: string | null; last: string | null };
  };
  time_series: { date: string; count: number }[];
  feedback: { good: number; bad: number; none: number };
};

/**
 * 講座のチャット分析（ChatGroupAnalyticsView）。
 * - date_range.first/last: min/max(created_at) の UTC ISO 8601（+00:00）。
 * - time_series.date: UTC 日付境界 → "YYYY-MM-DD"。
 * - feedback.none: feedback IS NULL の件数（'' は none に含めない）。
 * - 未所有/不在は notFound（→404 "Course not found."）。
 */
export async function getCourseChatAnalytics(
  env: Bindings,
  courseId: number,
  userId: string,
): Promise<{ notFound: true } | ChatAnalytics> {
  return withDb(env, async (db) => {
    // Scan the authorized course's history once, then derive both totals and days.
    const date = sql<string>`(${chatLogs.createdAt} AT TIME ZONE 'UTC')::date`;
    const day = db
      .select({
        date: date.as("date"),
        count: sql<number>`count(*)::int`.as("count"),
        first: sql<string | Date | null>`min(${chatLogs.createdAt})`.as(
          "first_dt",
        ),
        last: sql<string | Date | null>`max(${chatLogs.createdAt})`.as(
          "last_dt",
        ),
        good: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback}='good')::int`.as(
          "good",
        ),
        bad: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback}='bad')::int`.as(
          "bad",
        ),
        none: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback} IS NULL)::int`.as(
          "none",
        ),
      })
      .from(chatLogs)
      .where(eq(chatLogs.courseId, videoCourses.id))
      .groupBy(date)
      .as("day");
    const [s] = await db
      .select({
        total: sql<number>`COALESCE(sum(${day.count}),0)::int`,
        first_dt: sql<string | Date | null>`min(${day.first})`,
        last_dt: sql<string | Date | null>`max(${day.last})`,
        good: sql<number>`COALESCE(sum(${day.good}),0)::int`,
        bad: sql<number>`COALESCE(sum(${day.bad}),0)::int`,
        none: sql<number>`COALESCE(sum(${day.none}),0)::int`,
        time_series: sql<
          ChatAnalytics["time_series"]
        >`COALESCE(json_agg(json_build_object('date',${day.date}::text,'count',${day.count}) ORDER BY ${day.date}) FILTER(WHERE ${day.date} IS NOT NULL),'[]'::json)`,
      })
      .from(videoCourses)
      .leftJoinLateral(day, sql`true`)
      .where(
        and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)),
      )
      .groupBy(videoCourses.id);
    if (!s) return { notFound: true } as const;

    return {
      summary: {
        total_questions: s.total,
        date_range: {
          first: s.first_dt == null ? null : toUtcIso(s.first_dt),
          last: s.last_dt == null ? null : toUtcIso(s.last_dt),
        },
      },
      time_series: s.time_series,
      feedback: { good: s.good, bad: s.bad, none: s.none },
    };
  });
}

export async function getCourseChatHistory(
  env: Bindings,
  courseId: number,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ notFound: true } | { count: number; results: ChatLogItem[] }> {
  return withDb(env, async (db) => {
    const [total] = await db
      .select({
        count: sql<number>`(${db
          .select({ n: sql`count(*)::int` })
          .from(chatLogs)
          .where(eq(chatLogs.courseId, videoCourses.id))})`,
      })
      .from(videoCourses)
      .where(
        and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)),
      )
      .limit(1);
    if (!total) return { notFound: true } as const;
    if (offset >= total.count) return { count: total.count, results: [] };

    // Deep pages bound IDs before hydrating wide answers and attribution.
    // Keep the original plan on shallow pages where that extra work has no gain.
    const deferHydration = offset >= 1000;
    const historyPageFilter = deferHydration ? inArray(chatLogs.id, db
      .select({ id: chatLogs.id })
      .from(chatLogs)
      .where(eq(chatLogs.courseId, courseId))
      .orderBy(desc(chatLogs.createdAt), desc(chatLogs.id))
      .limit(limit)
      .offset(offset)) : undefined;
    const rows = await db
      .select({
        id: chatLogs.id,
        course_id: chatLogs.courseId,
        user_id: chatLogs.userId,
        username: users.username,
        email: users.email,
        question: chatLogs.question,
        answer: chatLogs.response,
        is_shared_origin: chatLogs.isSharedOrigin,
        feedback: chatLogs.feedback,
        created_at: chatLogs.createdAt,
        classroomAuthor: ltiChatLogSubjects.classroomAuthor,
      })
      .from(chatLogs)
      .leftJoin(users, eq(users.id, chatLogs.userId))
      .leftJoin(
        ltiChatLogSubjects,
        eq(ltiChatLogSubjects.chatLogId, chatLogs.id),
      )
      .where(and(eq(chatLogs.courseId, courseId), historyPageFilter))
      .orderBy(desc(chatLogs.createdAt), desc(chatLogs.id))
      .limit(limit)
      .offset(deferHydration ? 0 : offset);

    const results: ChatLogItem[] = rows.map((r) => ({
      id: Number(r.id),
      course: Number(r.course_id),
      asked_by:
        r.classroomAuthor ??
        mapQuestionAuthor(r.is_shared_origin, r.user_id, r.username, r.email),
      question: r.question,
      answer: chatAnswerSchema.parse(r.answer),
      is_shared_origin: r.is_shared_origin,
      feedback: chatFeedback(r.feedback),
      created_at: toUtcIso(r.created_at),
    }));

    return { count: total.count, results };
  });
}

export function createPostgresChatRepository(
  env: Bindings,
): import("../contracts/chat-repository").ChatRepository {
  return {
    context: (params) => getCourseWithMembers(env, params),
    create: (params) => createChatLog(env, params),
    deleteHistory: (courseId, userId) =>
      deleteCourseChatLogs(env, courseId, userId),
    exportPage: (courseId, userId, cursor) =>
      getCourseChatHistoryExportPage(env, courseId, userId, cursor),
    feedback: (logId, feedback, options) =>
      updateChatLogFeedback(env, logId, feedback, options),
    shareExists: (slug) => shareSlugExists(env, slug),
    analytics: (courseId, userId) =>
      getCourseChatAnalytics(env, courseId, userId),
    history: (courseId, userId, limit, offset) =>
      getCourseChatHistory(env, courseId, userId, limit, offset),
  };
}
