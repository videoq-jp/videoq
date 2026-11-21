import {
  and,
  or,
  eq,
  inArray,
  exists,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  runD1Batch,
  insertSelectValues,
  insertSelectFields,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  ltiCredentials as credentials,
  ltiOperationReservations as reservations,
  mutationReceipts as receipts,
  chatConversations as conversations,
  chatLogs,
  courseQuestions as questions,
  courseQuestionReplies as replies,
  courseQuestionLtiVotes as votes,
  courseQaModeration as moderation,
  ltiMaterialOperations as materialOperations,
  ltiCourseTagOperations as tagOperations,
  ltiReportAccesses as reportAccesses,
} from "../../db/schema/sqlite";
import {
  privacyErasurePlan,
  privacyOperationBarriers,
} from "../../application/privacy-policy";
import { ApiError } from "../../shared/errors";
import {
  privacyRequest,
  privacySubject,
  type PrivacyInstallation,
} from "../../shared/privacy";
import { operationReservationKey } from "../../shared/lti-operation-key";
import { privacyReadQueries } from "./privacy-read-definitions";
import { prepareD1PrivacyScope, checkD1PrivacyScope } from "./privacy-scope";
import type { z } from "zod";
type EraseRequest = Extract<
  z.infer<typeof privacyRequest>,
  { action: "erase" }
>;
const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
export function createD1PrivacyEraser(database: D1Database) {
  return {
    async execute(installation: PrivacyInstallation, input: EraseRequest) {
      const parsed = privacyRequest.safeParse(input);
      if (!parsed.success || parsed.data.action !== "erase")
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Invalid privacy erase request.",
        );
      input = parsed.data;
      const subject = await privacySubject(installation, input.subject),
        db = createD1Connection(database);
      for (let retry = 0; retry < 5; retry++) {
        const base = await prepareD1PrivacyScope(
            database,
            installation,
            [subject],
            input.contexts,
          ),
          scope = base.forSubject(subject),
          { p } = scope,
          defs = privacyReadQueries(scope);
        const ids = (name: keyof typeof defs) =>
          db.select({ id: defs[name].query.key }).from(defs[name].query);
        const operationIds = (
          kind: "material_operations" | "tag_operations",
        ) => {
          const q = defs[kind].query,
            ordered = db
              .select({
                id: sql<string>`CAST(${q.key} AS TEXT)`.as("operation_id_text"),
              })
              .from(q)
              .orderBy(sql`${q.key}`)
              .as("operation_ids");
          return db
            .select({ value: sql`json_group_array(${ordered.id})` })
            .from(ordered);
        };
        const materialIds = operationIds("material_operations"),
          tagIds = operationIds("tag_operations");
        const prepared = await runD1Batch<Record<string, unknown>>(database, [
          base.check(),
          scope.wrap(
            db
              .select({
                material: sql`${materialIds}`.as("material"),
                tag: sql`${tagIds}`.as("tag"),
              })
              .from(p),
          ),
        ]);
        if (!checkD1PrivacyScope(prepared[0].results[0])) continue;
        const snapshot = prepared[1].results[0],
          keys: Array<{ key: string }> = [];
        for (const { operation: kind } of privacyOperationBarriers) {
          const raw = snapshot[kind];
          if (typeof raw !== "string")
            throw new Error("Invalid privacy operation snapshot");
          const values = JSON.parse(raw) as string[];
          for (let offset = 0; offset < values.length; offset += 100)
            keys.push(
              ...(await Promise.all(
                values
                  .slice(offset, offset + 100)
                  .map(async (id) => ({
                    key: await operationReservationKey(kind, id),
                  })),
              )),
            );
        }
        const token = crypto.randomUUID(),
          gate = exists(
            db
              .select({ token: receipts.token })
              .from(receipts)
              .where(eq(receipts.token, token)),
          );
        const statements: D1Query[] = [
          base.check(),
          scope.wrap(
            db.insert(receipts).select(
              db
                .select(
                  insertSelectValues(receipts, {
                    token,
                    kind: "privacy_erase",
                    resourceId: 0,
                  }),
                )
                .from(p)
                .where(
                  and(
                    sql`${materialIds}=${snapshot.material}`,
                    sql`${tagIds}=${snapshot.tag}`,
                  ),
                ),
            ),
          ),
          db
            .insert(reservations)
            .select(
              db
                .select(
                  insertSelectFields(reservations, {
                    key: sql`json_extract(value,'$.key')`,
                  }),
                )
                .from(sql`json_each(${JSON.stringify(keys)})`)
                .where(gate),
            )
            .onConflictDoNothing(),
        ];
        const counts = new Map<string, number>();
        const mutate = (name: string, query: SQLWrapper) => {
          statements.push(scope.wrap(query));
          counts.set(name, statements.length);
          statements.push(
            db
              .select({ count: sql<number>`changes()`.as("count") })
              .from(sql`(VALUES(1)) input`),
          );
        };
        const sessions = db
          .select({ id: credentials.id })
          .from(p)
          .innerJoin(
            credentials,
            and(
              eq(credentials.kind, sql`'session'`),
              eq(
                sql`json_extract(${credentials.payload},'$.registrationId')`,
                p.registration,
              ),
              eq(
                sql`json_extract(${credentials.payload},'$.subjectHash')`,
                p.subjectHash,
              ),
            ),
          )
          .where(
            inArray(
              sql`coalesce(json_extract(${credentials.payload},'$.contextId'),'@orphan')`,
              db
                .select({ value: sql`value` })
                .from(sql`json_each(${p.contexts})`),
            ),
          );
        for (const effect of privacyErasurePlan()) {
          switch (effect.target) {
            case "feedback": {
              const logs = db
                .select({
                  id: sql<string>`CAST(${defs.logs.query.key} AS TEXT)`,
                })
                .from(defs.logs.query);
              mutate(
                effect.target,
                db
                  .delete(credentials)
                  .where(
                    and(
                      eq(credentials.kind, "lti-feedback"),
                      or(
                        and(
                          sql`json_type(${credentials.payload},'$.sessionHash')='text'`,
                          inArray(
                            sql`json_extract(${credentials.payload},'$.sessionHash')`,
                            sessions,
                          ),
                        ),
                        and(
                          sql`json_type(${credentials.payload},'$.logId') IN('integer','real','text')`,
                          inArray(
                            sql`CAST(json_extract(${credentials.payload},'$.logId') AS TEXT)`,
                            logs,
                          ),
                        ),
                      ),
                      gate,
                    ),
                  ),
              );
              break;
            }
            case "sessions":
              mutate(
                effect.target,
                db
                  .delete(credentials)
                  .where(and(inArray(credentials.id, sessions), gate)),
              );
              break;
            case "recentHistory":
              mutate(
                effect.target,
                db
                  .delete(credentials)
                  .where(
                    and(inArray(credentials.id, ids("recent_history")), gate),
                  ),
              );
              break;
            case "conversations":
              mutate(
                effect.target,
                db
                  .delete(conversations)
                  .where(
                    and(
                      inArray(
                        sql`'thread:'||${conversations.threadId}`,
                        ids("conversations"),
                      ),
                      gate,
                    ),
                  ),
              );
              break;
            case "logs":
              mutate(
                effect.target,
                db
                  .delete(chatLogs)
                  .where(and(inArray(chatLogs.id, ids("logs")), gate)),
              );
              break;
            case "questions": {
              const f = effect.fields;
              mutate(
                effect.target,
                db
                  .update(questions)
                  .set({
                    title: f.title,
                    body: f.body,
                    ltiAuthorId: f.author,
                    ltiInstructor: f.instructor,
                    featured: f.featured,
                    updatedAt: now,
                  })
                  .where(and(inArray(questions.id, ids("questions")), gate)),
              );
              break;
            }
            case "replies": {
              const f = effect.fields;
              mutate(
                effect.target,
                db
                  .update(replies)
                  .set({
                    body: f.body,
                    ltiAuthorId: f.author,
                    ltiInstructor: f.instructor,
                    updatedAt: now,
                  })
                  .where(and(inArray(replies.id, ids("replies")), gate)),
              );
              break;
            }
            case "votes":
              mutate(
                effect.target,
                db
                  .delete(votes)
                  .where(
                    and(
                      inArray(
                        sql`(${votes.questionId},${votes.ltiAuthorId})`,
                        db
                          .select({
                            question: defs.votes.query.key,
                            author: defs.votes.query.authorKey,
                          })
                          .from(defs.votes.query),
                      ),
                      gate,
                    ),
                  ),
              );
              break;
            case "moderation":
              mutate(
                effect.target,
                db
                  .update(moderation)
                  .set({ ltiActorId: effect.actor })
                  .where(and(inArray(moderation.id, ids("moderation")), gate)),
              );
              break;
            case "materialOperations":
            case "tagOperations": {
              const barrier = privacyOperationBarriers.find(
                  (b) => b.count === effect.target,
                )!,
                table =
                  effect.target === "materialOperations"
                    ? materialOperations
                    : tagOperations;
              mutate(
                effect.target,
                db
                  .delete(table)
                  .where(and(inArray(table.id, ids(barrier.collection)), gate)),
              );
              break;
            }
            case "reportAccesses":
              mutate(
                effect.target,
                db
                  .delete(reportAccesses)
                  .where(
                    and(
                      inArray(reportAccesses.id, ids("report_accesses")),
                      gate,
                    ),
                  ),
              );
              break;
          }
        }
        const receipt = statements.length;
        statements.push(
          db
            .select({ token: receipts.token })
            .from(receipts)
            .where(eq(receipts.token, token)),
          db.delete(receipts).where(eq(receipts.token, token)),
        );
        const result = await runD1Batch<Record<string, unknown>>(
          database,
          statements,
        );
        if (!checkD1PrivacyScope(result[0].results[0])) continue;
        if (result[receipt].results.length)
          return {
            erased: Object.fromEntries(
              [...counts].map(([name, index]) => [
                name,
                Number(result[index].results[0].count),
              ]),
            ),
          };
      }
      throw new ApiError(409, "CONFLICT", "Data changed. Restart the erasure.");
    },
  };
}
