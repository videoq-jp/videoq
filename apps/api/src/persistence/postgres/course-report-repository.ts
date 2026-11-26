import { and, eq, notExists, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import {
  ltiCredentials,
  lmsCourses,
  videoCourses,
  lmsResources,
  videoCourseMembers,
  videos,
  chatLogs,
  ltiChatLogSubjects,
  ltiReportAccesses,
} from "../../db/schema";
import {
  reportMediaAllowed,
  reportGrantMatches,
  reportLogAllowed,
  courseReportVideoIds} from '../../domain/learning/course-report';
import { reportDrizzleLogic as logic } from "../course-report-policy-sql";
import { lockLmsGrant } from "./lms-resource-repository";
import { lockLtiDataSessionWithDb } from "./lti-session-lock";
import {
  reportDenied as denied,
  checkCourseReport,
} from "../../shared/course-report";
import { digest } from "../../features/lti/store";
import type { Bindings } from "../../types/bindings";
import type { CourseReportRepository } from "../contracts/course-report-repository";

export function createPostgresCourseReportRepository(
  env: Bindings,
): CourseReportRepository {
  return {
    async summarize(scope, input, actorKey) {
      checkCourseReport(scope, input);
      return withDb(env, (db) =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'`,
          );
          await lockLmsGrant(
            tx,
            { id: scope.installationId, ownerUserId: scope.ownerUserId },
            scope.contextId,
            scope.courseId,
          );
          await lockLtiDataSessionWithDb(
            tx,
            scope.ownerUserId,
            scope.sessionProof,
          );
          const session = await tx
            .select({ id: ltiCredentials.id })
            .from(ltiCredentials)
            .where(
              and(
                eq(ltiCredentials.id, scope.sessionProof.sessionHash),
                sql`${ltiCredentials.payload}->>'contextId'=${scope.contextId}`,
                sql`${ltiCredentials.payload}->>'courseId'=${String(scope.courseId)}`,
              ),
            );
          if (session.length !== 1) throw denied();
          const course = await tx
            .select({ id: lmsCourses.id })
            .from(lmsCourses)
            .innerJoin(videoCourses, eq(videoCourses.id, lmsCourses.courseId))
            .where(
              and(
                eq(lmsCourses.installationId, scope.installationId),
                eq(lmsCourses.contextId, scope.contextId),
                eq(lmsCourses.courseId, scope.courseId),
                eq(videoCourses.userId, scope.ownerUserId),
                eq(videoCourses.managedByLms, true),
              ),
            )
            .for("share", { of: [lmsCourses, videoCourses] });
          if (course.length !== 1) throw denied();
          const resources = await tx
            .select({ id: lmsResources.videoId })
            .from(lmsResources)
            .innerJoin(
              videoCourseMembers,
              and(
                eq(videoCourseMembers.courseId, lmsResources.courseId),
                eq(videoCourseMembers.videoId, lmsResources.videoId),
              ),
            )
            .innerJoin(
              videos,
              and(
                eq(videos.id, lmsResources.videoId),
                reportMediaAllowed(
                  eq(videos.userId, scope.ownerUserId),
                  eq(videos.managedByLms, true),
                  videos.status,
                  logic,
                ),
              ),
            )
            .innerJoin(
              sql`jsonb_to_recordset(${JSON.stringify(scope.readable)}::jsonb) AS granted("videoId" bigint,generation bigint,"resourceLinkId" text)`,
              reportGrantMatches(
                sql`granted."videoId"=${lmsResources.videoId}`,
                sql`granted.generation=${lmsResources.generation}`,
                sql`granted."resourceLinkId"=${lmsResources.resourceLinkId}`,
                logic,
              ),
            )
            .where(
              and(
                eq(lmsResources.installationId, scope.installationId),
                eq(lmsResources.contextId, scope.contextId),
                eq(lmsResources.courseId, scope.courseId),
                eq(lmsResources.enabled, true),
              ),
            )
            .for("share", { of: [lmsResources, videoCourseMembers, videos] });
          const ids = courseReportVideoIds(
              resources.map((row) => Number(row.id)),
            ),
            encoded = JSON.stringify(ids);
          const date = sql<string>`(${chatLogs.createdAt} AT TIME ZONE 'UTC')::date`;
          const source = sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${chatLogs.response}->'sources')='array' THEN ${chatLogs.response}->'sources' ELSE '[]'::jsonb END) source`;
          const readable = reportLogAllowed(
            {
              originalNonempty: sql`jsonb_array_length(${ltiChatLogSubjects.resourceVideoIds})>0`,
              originalReadable: sql`${ltiChatLogSubjects.resourceVideoIds}<@${encoded}::jsonb`,
              responseObject: sql`jsonb_typeof(${chatLogs.response})='object'`,
              sourcesArray: sql`jsonb_typeof(${chatLogs.response}->'sources')='array'`,
              allSourcesReadable: notExists(
                tx
                  .select({ value: sql`source` })
                  .from(source)
                  .where(
                    sql`NOT (${encoded}::jsonb @> jsonb_build_array(source->'video_id'))`,
                  ),
              ),
            },
            logic,
          );
          const days = await tx
            .select({
              date: sql<string>`${date}::text`,
              questions: sql<number>`count(*)::int`,
              good: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback}='good')::int`,
              bad: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback}='bad')::int`,
              none: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback} IS NULL)::int`,
            })
            .from(chatLogs)
            .innerJoin(
              ltiChatLogSubjects,
              eq(ltiChatLogSubjects.chatLogId, chatLogs.id),
            )
            .where(
              and(
                eq(chatLogs.userId, scope.ownerUserId),
                eq(chatLogs.courseId, scope.courseId),
                eq(
                  ltiChatLogSubjects.registrationId,
                  "db:" + scope.installationId,
                ),
                eq(ltiChatLogSubjects.contextId, scope.contextId),
                sql`${chatLogs.createdAt}>=${input.from}::date::timestamp AT TIME ZONE 'UTC'`,
                sql`${chatLogs.createdAt}<(${input.to}::date+1)::timestamp AT TIME ZONE 'UTC'`,
                readable,
              ),
            )
            .groupBy(date)
            .orderBy(date);
          await tx
            .insert(ltiReportAccesses)
            .values({
              installationId: scope.installationId,
              courseId: scope.courseId,
              contextId: scope.contextId,
              actorKey,
              fromDate: input.from,
              toDate: input.to,
              resourceCount: ids.length,
              scopeHash: await digest(encoded),
            });
          return days;
        }),
      );
    },
  };
}
