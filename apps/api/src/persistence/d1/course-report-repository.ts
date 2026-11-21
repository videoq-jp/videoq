import { and, eq, exists, notExists, sql, type SQL } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectValues, runD1Batch } from "../../db/d1/query-builders";
import {
  lmsResources,
  videoCourseMembers,
  videos,
  lmsInstallations,
  lmsCourses,
  teachingConnections,
  users,
  videoCourses,
  ltiCredentials,
  chatLogs,
  ltiChatLogSubjects,
  ltiReportAccesses,
} from "../../db/schema/sqlite";
import {
  reportMediaAllowed,
  reportGrantMatches,
  reportLogAllowed,
} from "../../application/course-report";
import { reportDrizzleLogic as logic } from "../course-report-policy-sql";
import { activeD1LmsOwner } from "./lms-owner-policy";
import { checkCourseReport, reportDenied } from "../../shared/course-report";
import { digest } from "../../features/lti/store";
import type {
  CourseReportRepository,
  ReportDay,
} from "../contracts/course-report-repository";

const safeJson = (value: SQL) =>
  sql`CASE WHEN json_valid(${value}) THEN ${value} ELSE '{}' END`;
export function createD1CourseReportRepository(
  database: D1Database,
): CourseReportRepository {
  const db = createD1Connection(database),
    oneRow = sql`json_each('[0]')`;
  return {
    async summarize(scope, input, actorKey) {
      checkCourseReport(scope, input);
      const resourceIds = db
        .selectDistinct({ id: lmsResources.videoId })
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
          sql`json_each(${JSON.stringify(scope.readable)}) granted`,
          reportGrantMatches(
            sql`json_extract(granted.value,'$.videoId')=${lmsResources.videoId}`,
            sql`json_extract(granted.value,'$.generation')=${lmsResources.generation}`,
            sql`json_extract(granted.value,'$.resourceLinkId')=${lmsResources.resourceLinkId}`,
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
        .orderBy(lmsResources.videoId)
        .as("resource_ids");
      const idsQuery = db
        .select({ ids: sql<string>`json_group_array(${resourceIds.id})` })
        .from(resourceIds);
      const authority = exists(
        db
          .select({ id: lmsInstallations.id })
          .from(lmsInstallations)
          .innerJoin(
            lmsCourses,
            eq(lmsCourses.installationId, lmsInstallations.id),
          )
          .innerJoin(
            teachingConnections,
            and(
              eq(teachingConnections.provider, "moodle"),
              eq(teachingConnections.installationId, lmsInstallations.id),
              eq(teachingConnections.contextId, lmsCourses.contextId),
              eq(teachingConnections.courseId, lmsCourses.courseId),
              eq(teachingConnections.active, true),
            ),
          )
          .innerJoin(users, eq(users.id, teachingConnections.ownerUserId))
          .innerJoin(videoCourses, eq(videoCourses.id, lmsCourses.courseId))
          .innerJoin(
            ltiCredentials,
            eq(ltiCredentials.id, scope.sessionProof.sessionHash),
          )
          .where(
            and(
              eq(lmsInstallations.id, scope.installationId),
              eq(users.id, scope.ownerUserId),
              eq(lmsInstallations.active, true),
              activeD1LmsOwner(),
              eq(lmsCourses.contextId, scope.contextId),
              eq(lmsCourses.courseId, scope.courseId),
              eq(videoCourses.userId, users.id),
              eq(videoCourses.managedByLms, true),
              eq(ltiCredentials.kind, "session"),
              sql`julianday(${ltiCredentials.expiresAt})>julianday('now')`,
              sql`json_extract(${ltiCredentials.payload},'$.registrationId')=${scope.sessionProof.registrationId}`,
              sql`json_extract(${ltiCredentials.payload},'$.subjectHash')=${scope.sessionProof.subjectHash}`,
              sql`json_extract(${ltiCredentials.payload},'$.contextId')=${lmsCourses.contextId}`,
              sql`json_extract(${ltiCredentials.payload},'$.courseId')=${lmsCourses.courseId}`,
            ),
          ),
      );
      for (let retry = 0; retry < 5; retry++) {
        const ids = (await idsQuery.get())?.ids;
        if (!ids) throw reportDenied();
        const auditId = crypto.randomUUID(),
          scopeHash = await digest(ids),
          count = (JSON.parse(ids) as number[]).length;
        const response = safeJson(sql`${chatLogs.response}`),
          original = safeJson(sql`${ltiChatLogSubjects.resourceVideoIds}`);
        const priorAllowed = notExists(
          db
            .select({ value: sql`prior.value` })
            .from(sql`json_each(${original}) prior`)
            .where(
              sql`prior.type NOT IN('integer','real') OR NOT (${exists(
                db
                  .select({ value: sql`granted.value` })
                  .from(sql`json_each(${ids}) granted`)
                  .where(sql`granted.value=prior.value`),
              )})`,
            ),
        );
        const sourceValue = sql`CASE WHEN source.type='object' THEN source.value ELSE '{}' END`;
        const sourcesAllowed = notExists(
          db
            .select({ value: sql`source.value` })
            .from(
              sql`json_each(CASE WHEN json_type(${response},'$.sources')='array' THEN ${response}->'$.sources' ELSE '[]' END) source`,
            )
            .where(
              sql`json_type(${sourceValue},'$.video_id') IS NULL OR json_type(${sourceValue},'$.video_id') NOT IN('integer','real') OR NOT (${exists(
                db
                  .select({ value: sql`granted.value` })
                  .from(sql`json_each(${ids}) granted`)
                  .where(
                    sql`granted.value=json_extract(${sourceValue},'$.video_id')`,
                  ),
              )})`,
            ),
        );
        const readable = reportLogAllowed(
          {
            originalNonempty: sql`json_type(${original})='array' AND json_array_length(${original})>0`,
            originalReadable: priorAllowed,
            responseObject: sql`json_type(${response})='object'`,
            sourcesArray: sql`json_type(${response},'$.sources')='array'`,
            allSourcesReadable: sourcesAllowed,
          },
          logic,
        );
        const date = sql<string>`date(${chatLogs.createdAt})`;
        const result = await runD1Batch(database, [
          db.insert(ltiReportAccesses).select(
            db
              .select(
                insertSelectValues(ltiReportAccesses, {
                  id: auditId,
                  installationId: scope.installationId,
                  courseId: scope.courseId,
                  contextId: scope.contextId,
                  actorKey,
                  fromDate: input.from,
                  toDate: input.to,
                  resourceCount: count,
                  scopeHash,
                }),
              )
              .from(oneRow)
              .where(and(authority, sql`(${idsQuery})=${ids}`)),
          ),
          db
            .select({
              date: date.as("date"),
              questions: sql<number>`count(*)`.as("questions"),
              good: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback}='good')`.as(
                "good",
              ),
              bad: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback}='bad')`.as(
                "bad",
              ),
              none: sql<number>`count(*) FILTER(WHERE ${chatLogs.feedback} IS NULL)`.as(
                "none",
              ),
            })
            .from(chatLogs)
            .innerJoin(
              ltiChatLogSubjects,
              eq(ltiChatLogSubjects.chatLogId, chatLogs.id),
            )
            .where(
              and(
                exists(
                  db
                    .select({ id: ltiReportAccesses.id })
                    .from(ltiReportAccesses)
                    .where(eq(ltiReportAccesses.id, auditId)),
                ),
                eq(chatLogs.userId, scope.ownerUserId),
                eq(chatLogs.courseId, scope.courseId),
                eq(
                  ltiChatLogSubjects.registrationId,
                  scope.sessionProof.registrationId,
                ),
                eq(ltiChatLogSubjects.contextId, scope.contextId),
                sql`julianday(${chatLogs.createdAt})>=julianday(${input.from})`,
                sql`julianday(${chatLogs.createdAt})<julianday(${input.to},'+1 day')`,
                readable,
              ),
            )
            .groupBy(date)
            .orderBy(date),
          db.select({ allowed: authority.as("allowed") }).from(oneRow),
        ]);
        if (result[0].meta.changes === 1)
          return result[1].results.map(
            (row) =>
              ({
                date: String(row.date),
                questions: Number(row.questions),
                good: Number(row.good),
                bad: Number(row.bad),
                none: Number(row.none),
              }) satisfies ReportDay,
          );
        if (!result[2].results[0]?.allowed) throw reportDenied();
      }
      throw reportDenied();
    },
  };
}
