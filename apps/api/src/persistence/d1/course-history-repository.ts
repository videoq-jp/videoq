import {
  and,
  or,
  eq,
  exists,
  notExists,
  inArray,
  sql,
  desc,
  asc,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  COURSE_HISTORY_MAX_TURNS,
  courseHistoryScopeIds,
  courseHistoryAttribution,
  retainedCourseHistory,
} from "../../domain/learning/course-history";
import { historyDrizzleChoice } from "../course-history-policy-sql";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  users,
  ltiCredentials as credentials,
  videoCourses,
  videoCourseMembers,
  chatLogs,
} from "../../db/schema/sqlite";
import type {
  CourseHistoryRepository,
  CourseHistoryScope,
} from "../contracts/course-history-repository";
import { checkHistoryScope, historyDenied } from "../../shared/course-history";
const safeJson = (column: SQLWrapper) =>
  sql`CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
const decode = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};
export function createD1CourseHistoryRepository(
  database: D1Database,
): CourseHistoryRepository {
  const db = createD1Connection(database);
  function guard(scope: CourseHistoryScope, ownerUserId?: string) {
    checkHistoryScope(scope);
    const proof = scope.sessionProof;
    if (!proof) return sql`1`;
    const session = alias(credentials, "session");
    const owner =
      ownerUserId === undefined
        ? db
            .select({ id: videoCourses.userId })
            .from(videoCourses)
            .where(eq(videoCourses.id, scope.courseId))
        : sql`${ownerUserId}`;
    return exists(
      db
        .select({ id: users.id })
        .from(users)
        .innerJoin(session, eq(session.id, proof.sessionHash))
        .where(
          and(
            eq(users.id, owner),
            eq(session.kind, "session"),
            sql`julianday(${session.expiresAt})>julianday('now')`,
            eq(
              sql`json_extract(${session.payload},'$.registrationId')`,
              proof.registrationId,
            ),
            eq(
              sql`json_extract(${session.payload},'$.subjectHash')`,
              proof.subjectHash,
            ),
          ),
        ),
    );
  }
  return {
    async append(scope, id, turn, allowed, expiresAt) {
      const authority = guard(scope),
        old = safeJson(credentials.payload);
      const priorType = sql`prior.type`,
        priorValue = sql`prior.value`;
      const compatible = notExists(
        db
          .select({ value: priorValue })
          .from(sql`json_each(${old},'$.scopeVideoIds') prior`)
          .where(
            or(
              sql`${priorType} NOT IN('integer','real')`,
              sql`${priorValue}<=0`,
              sql`${priorValue}>9007199254740991`,
              sql`${priorValue}<>CAST(${priorValue} AS INTEGER)`,
              notExists(
                db
                  .select({ value: sql`next.value` })
                  .from(sql`json_each(excluded.payload,'$.scopeVideoIds') next`)
                  .where(
                    and(
                      sql`next.type='integer'`,
                      eq(sql`next.value`, priorValue),
                    ),
                  ),
              ),
            ),
          ),
      );
      const previous = retainedCourseHistory(
        {
          live: sql`julianday(${credentials.expiresAt})>julianday('now')`,
          scopeArray: sql`json_type(${old},'$.scopeVideoIds')='array'`,
          turnsArray: sql`json_type(${old},'$.turns')='array'`,
          scopeCompatible: compatible,
        },
        sql`${old} -> '$.turns'`,
        sql`'[]'`,
        historyDrizzleChoice,
      );
      // Retain the newest bounded page atomically, then restore chronological order.
      // Preserve arbitrary JSON values without turning objects/booleans into strings.
      const latest = db
        .select({
          key: sql<number>`key`.as("entry_key"),
          value: sql`value`.as("entry_value"),
          type: sql<string>`type`.as("entry_type"),
        })
        .from(
          sql`json_each(json_insert(${previous},'$[#]',json(excluded.payload -> '$.turns[0]')))`,
        )
        .orderBy(desc(sql`CAST(key AS INTEGER)`))
        .limit(COURSE_HISTORY_MAX_TURNS)
        .as("latest");
      const chronological = db
        .select({
          value: sql`${latest.value}`.as("entry_value"),
          type: sql`${latest.type}`.as("entry_type"),
        })
        .from(latest)
        .orderBy(asc(sql`CAST(${latest.key} AS INTEGER)`))
        .as("chronological");
      const recent = db
        .select({
          value: sql`json_group_array(CASE WHEN ${chronological.type} IN('array','object') THEN json(${chronological.value}) WHEN ${chronological.type}='true' THEN json('true') WHEN ${chronological.type}='false' THEN json('false') ELSE ${chronological.value} END)`,
        })
        .from(chronological);
      const members = db
        .selectDistinct({ id: videoCourseMembers.videoId })
        .from(videoCourseMembers)
        .where(eq(videoCourseMembers.courseId, scope.courseId))
        .orderBy(videoCourseMembers.videoId)
        .as("members");
      const memberScope = db
        .select({ value: sql`json_group_array(${members.id})` })
        .from(members);
      const scopeJson =
        allowed === undefined
          ? sql`(${memberScope})`
          : sql`${JSON.stringify(courseHistoryScopeIds(allowed))}`;
      const payload = sql`json_set(json(${JSON.stringify(courseHistoryAttribution(scope))}),'$.scopeVideoIds',json(${scopeJson}),'$.turns',json_array(json(${JSON.stringify(turn)})))`;
      const result = await db
        .insert(credentials)
        .select(
          db
            .select(
              insertSelectFields(credentials, {
                id: sql`${id}`,
                kind: sql`'lti-history'`,
                payload,
                expiresAt: sql`${expiresAt.toISOString()}`,
              }),
            )
            .from(sql`(VALUES(1)) input`)
            .where(authority),
        )
        .onConflictDoUpdate({
          target: credentials.id,
          set: {
            expiresAt,
            payload: sql`json_set(excluded.payload,'$.turns',json((${recent})))`,
          },
          setWhere: eq(credentials.kind, "lti-history"),
        })
        .returning({ id: credentials.id })
        .get();
      if (!result) throw historyDenied();
    },
    async read(scope, id, ownerUserId) {
      const authority = guard(scope, ownerUserId),
        h = alias(credentials, "h"),
        payload = safeJson(h.payload);
      const turn = sql`CASE WHEN turn.type='object' THEN turn.value ELSE '{}' END`;
      const ids = db
        .select({ id: sql<number>`json_extract(${turn},'$.logId')` })
        .from(
          sql`json_each(CASE WHEN json_type(${payload},'$.turns')='array' AND json_array_length(${payload},'$.turns')<=${COURSE_HISTORY_MAX_TURNS} THEN ${payload} -> '$.turns' ELSE '[]' END) turn`,
        )
        .where(sql`json_type(${turn},'$.logId') IN('integer','real')`);
      const logs = db
        .select({
          value: sql`json_group_array(json_object('id',${chatLogs.id},'answer',${chatLogs.response},'feedback',${chatLogs.feedback}))`,
        })
        .from(chatLogs)
        .where(
          and(
            eq(chatLogs.userId, ownerUserId),
            eq(chatLogs.courseId, scope.courseId),
            inArray(chatLogs.id, ids),
          ),
        );
      const result = await runD1Batch(database, [
        db
          .select({ allowed: authority.as("allowed") })
          .from(sql`(VALUES(1)) input`),
        db
          .select({
            payload: sql<string>`${h.payload}`.as("payload"),
            logs: sql<string>`coalesce((${logs}),'[]')`.as("logs"),
          })
          .from(h)
          .where(
            and(
              eq(h.id, id),
              eq(h.kind, "lti-history"),
              sql`julianday(${h.expiresAt})>julianday('now')`,
              authority,
            ),
          ),
      ]);
      if (!result[0].results[0]?.allowed) throw historyDenied();
      const row = result[1].results[0] as
        { payload: string; logs: string } | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.logs) as Array<{
        id: number;
        answer: string;
        feedback: string | null;
      }>;
      return {
        payload: decode(row.payload),
        logs: parsed.map((log) => ({
          ...log,
          id: Number(log.id),
          answer: decode(log.answer),
        })),
      };
    },
  };
}
