import {
  COURSE_HISTORY_MAX_TURNS,
  courseHistoryScopeIds,
  courseHistoryAttribution,
  retainedCourseHistory,
} from "../../application/course-history-append";
import { historyDrizzleChoice } from "../course-history-policy-sql";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { withDb } from "../../db/pool";
import {
  chatLogs,
  ltiCredentials,
  videoCourseMembers,
  videoCourses,
} from "../../db/schema";
import { lockLtiDataSessionWithDb } from "./lti-session-lock";
import {
  savedCourseHistory,
  checkHistoryScope,
  historyDenied,
} from "../../shared/course-history";
import type { Bindings } from "../../types/bindings";
import type { CourseHistoryRepository } from "../contracts/course-history-repository";
export function createPostgresCourseHistoryRepository(
  env: Bindings,
): CourseHistoryRepository {
  return {
    async append(scope, id, turn, allowed, expiresAt) {
      checkHistoryScope(scope);
      await withDb(env, (database) =>
        database.transaction(async (db) => {
          if (scope.sessionProof) {
            const [course] = await db
              .select({ owner: videoCourses.userId })
              .from(videoCourses)
              .where(eq(videoCourses.id, scope.courseId));
            if (!course) throw historyDenied();
            await lockLtiDataSessionWithDb(
              db,
              course.owner,
              scope.sessionProof,
            );
          }
          const members =
            allowed ??
            (
              await db
                .select({ id: videoCourseMembers.videoId })
                .from(videoCourseMembers)
                .where(eq(videoCourseMembers.courseId, scope.courseId))
            ).map((row) => row.id);
          const scopeJson = JSON.stringify(courseHistoryScopeIds(members));
          // Atomic append protects simultaneous pages. A reduced permission scope drops
          // prior context instead of exposing answers from newly restricted videos.
          const previous = retainedCourseHistory(
            {
              live: sql`${ltiCredentials.expiresAt} > clock_timestamp()`,
              scopeArray: sql`jsonb_typeof(${ltiCredentials.payload}->'scopeVideoIds')='array'`,
              turnsArray: sql`jsonb_typeof(${ltiCredentials.payload}->'turns')='array'`,
              scopeCompatible: sql`(${ltiCredentials.payload}->'scopeVideoIds') <@ ${scopeJson}::jsonb`,
            },
            sql`coalesce(${ltiCredentials.payload}->'turns', '[]'::jsonb)`,
            sql`'[]'::jsonb`,
            historyDrizzleChoice,
          );
          const attribution = courseHistoryAttribution(scope);
          const recent = db
            .select({
              item: sql`item`.as("item"),
              ord: sql<number>`ord`.as("ord"),
            })
            .from(
              sql`jsonb_array_elements((${previous})||${JSON.stringify([turn])}::jsonb) WITH ORDINALITY AS entries(item,ord)`,
            )
            .orderBy(desc(sql`ord`))
            .limit(COURSE_HISTORY_MAX_TURNS)
            .as("recent");
          const turns = db
            .select({
              value: sql`jsonb_agg(${recent.item} ORDER BY ${recent.ord})`,
            })
            .from(recent);
          const changed = await db
            .insert(ltiCredentials)
            .values({
              id,
              kind: "lti-history",
              payload: {
                ...attribution,
                scopeVideoIds: JSON.parse(scopeJson) as number[],
                turns: [turn],
              },
              expiresAt,
            })
            .onConflictDoUpdate({
              target: ltiCredentials.id,
              set: {
                expiresAt,
                payload: sql`${JSON.stringify(attribution)}::jsonb || jsonb_build_object('scopeVideoIds', ${scopeJson}::jsonb, 'turns',
        (${turns}))`,
              },
              setWhere: eq(ltiCredentials.kind, "lti-history"),
            })
            .returning({ id: ltiCredentials.id });
          if (!changed.length) throw historyDenied();
        }),
      );
    },
    async read(scope, id, ownerUserId) {
      checkHistoryScope(scope);
      return withDb(env, (database) =>
        database.transaction(async (db) => {
          await lockLtiDataSessionWithDb(db, ownerUserId, scope.sessionProof);
          const [row] = await db
            .select({ payload: ltiCredentials.payload })
            .from(ltiCredentials)
            .where(
              and(
                eq(ltiCredentials.id, id),
                eq(ltiCredentials.kind, "lti-history"),
                sql`${ltiCredentials.expiresAt}>clock_timestamp()`,
              ),
            )
            .for("share")
            .limit(1);
          if (!row) return null;
          const record = savedCourseHistory.safeParse(row.payload);
          if (!record.success || !record.data.turns.length)
            return { payload: row.payload, logs: [] };
          const logs = await db
            .select({
              id: chatLogs.id,
              answer: chatLogs.response,
              feedback: chatLogs.feedback,
            })
            .from(chatLogs)
            .where(
              and(
                eq(chatLogs.userId, ownerUserId),
                eq(chatLogs.courseId, scope.courseId),
                inArray(
                  chatLogs.id,
                  record.data.turns.map((t) => t.logId),
                ),
              ),
            );
          return { payload: row.payload, logs };
        }),
      );
    },
  };
}
