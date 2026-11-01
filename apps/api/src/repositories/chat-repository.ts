import { chatAnswerSchema, chatAnswerText, type ChatAnswer, type ChatSource } from "@videoq/trpc/chat";
import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { withDb } from "../db/pool";
import {
  chatLogs,
  users,
  videoCourses,
  videoCourseMembers,
  videoCourseMemberships,
} from "../db/schema";
import { toUtcIso } from "../shared/datetime";
import type { Bindings } from "../types/bindings";

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
    isSharedOrigin
    || typeof userId !== "string"
    || typeof username !== "string"
    || typeof email !== "string"
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
  params: { courseId: number; userId?: string | null; shareToken?: string | null },
): Promise<GroupChatContext | null> {
  if (!params.shareToken && !params.userId) return null;
  return withDb(env, async (db) => {
    const conditions = [eq(videoCourses.id, params.courseId)];
    if (params.shareToken) {
      conditions.push(eq(videoCourses.shareSlug, params.shareToken));
    } else if (params.userId) {
      conditions.push(
        or(
          eq(videoCourses.userId, params.userId),
          sql`EXISTS (
            SELECT 1 FROM ${videoCourseMemberships}
             WHERE ${videoCourseMemberships.courseId} = ${videoCourses.id}
               AND ${videoCourseMemberships.userId} = ${params.userId}
          )`,
        )!,
      );
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
      memberVideoIds: members.map((m) => Number(m.videoId)),
    };
  });
}

/** Persist the validated answer; AI quality evaluation has been retired. */
export async function createChatLog(
  env: Bindings,
  params: {
    userId: string;
    courseId: number;
    question: string;
    answer: ChatAnswer;
    isShared: boolean;
    retrievedContexts: readonly string[];
  },
): Promise<{ id: number; feedback: string | null }> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const rows = await tx
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
    }),
  );
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
        .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)))
        .limit(1);
      if (owner.length === 0) return { notFound: true } as const;

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
      .where(and(eq(chatLogs.courseId, courseId), afterCursor))
      .orderBy(asc(chatLogs.createdAt), asc(chatLogs.id))
      .limit(CHAT_HISTORY_EXPORT_PAGE_SIZE);

    const last = selected.at(-1);

    return {
      rows: selected.map((row) => {
        const answer = chatAnswerSchema.parse(row.answer);
        return {
          created_at: toUtcIso(row.createdAt),
          asked_by: mapQuestionAuthor(
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
  opts: { userId?: string; shareSlug?: string | null },
) {
  const permission = opts.shareSlug
    ? sql`course.share_slug = ${opts.shareSlug} AND log.is_shared_origin = true`
    : sql`course.user_id = ${opts.userId ?? null} OR log.user_id = ${opts.userId ?? null}`;
  return withDb(env, async (db) => {
    const result = await db.execute<{ allowed: boolean; id: string | null; feedback: string | null }>(sql`
      WITH target AS (
        SELECT log.id, COALESCE((${permission}), false) AS allowed
          FROM chat_logs log
          JOIN video_courses course ON course.id = log.course_id
         WHERE log.id = ${logId}
      ), updated AS (
        UPDATE chat_logs log SET feedback = ${feedback}
          FROM target
         WHERE log.id = target.id AND target.allowed
        RETURNING log.id, log.feedback
      )
      SELECT target.allowed, updated.id, updated.feedback
        FROM target LEFT JOIN updated ON updated.id = target.id
    `);
    const row = result.rows[0];
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
      .where(eq(videoCourses.shareSlug, shareSlug))
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
    const result = await db.execute(sql`
      SELECT COALESCE(sum(day.count), 0)::int AS total,
             min(day.first_dt) AS first_dt,
             max(day.last_dt) AS last_dt,
             COALESCE(sum(day.good), 0)::int AS good,
             COALESCE(sum(day.bad), 0)::int AS bad,
             COALESCE(sum(day.none), 0)::int AS none,
             COALESCE(
               json_agg(json_build_object('date', day.date::text, 'count', day.count) ORDER BY day.date)
                 FILTER (WHERE day.date IS NOT NULL), '[]'::json
             ) AS time_series
        FROM video_courses course
        LEFT JOIN LATERAL (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS date,
                 count(*)::int AS count,
                 min(created_at) AS first_dt,
                 max(created_at) AS last_dt,
                 count(*) FILTER (WHERE feedback = 'good')::int AS good,
                 count(*) FILTER (WHERE feedback = 'bad')::int AS bad,
                 count(*) FILTER (WHERE feedback IS NULL)::int AS none
            FROM chat_logs WHERE course_id = course.id
           GROUP BY (created_at AT TIME ZONE 'UTC')::date
        ) day ON true
       WHERE course.id = ${courseId} AND course.user_id = ${userId}
       GROUP BY course.id
    `);
    const s = result.rows[0] as {
      total: number;
      first_dt: string | Date | null;
      last_dt: string | Date | null;
      good: number;
      bad: number;
      none: number;
      time_series: ChatAnalytics["time_series"];
    } | undefined;
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
        count: sql<number>`(SELECT count(*)::int FROM chat_logs WHERE course_id = "video_courses"."id")`,
      })
      .from(videoCourses)
      .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, userId)))
      .limit(1);
    if (!total) return { notFound: true } as const;
    if (offset >= total.count) return { count: total.count, results: [] };

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
      })
      .from(chatLogs)
      .leftJoin(users, eq(users.id, chatLogs.userId))
      .where(eq(chatLogs.courseId, courseId))
      .orderBy(desc(chatLogs.createdAt), desc(chatLogs.id))
      .limit(limit)
      .offset(offset);

    const results: ChatLogItem[] = rows.map((r) => ({
      id: Number(r.id),
      course: Number(r.course_id),
      asked_by: mapQuestionAuthor(
        r.is_shared_origin,
        r.user_id,
        r.username,
        r.email,
      ),
      question: r.question,
      answer: chatAnswerSchema.parse(r.answer),
      is_shared_origin: r.is_shared_origin,
      feedback: chatFeedback(r.feedback),
      created_at: toUtcIso(r.created_at),
    }));

    return { count: total.count, results };
  });
}
