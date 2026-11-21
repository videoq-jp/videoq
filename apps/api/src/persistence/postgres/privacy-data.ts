import {
  and,
  or,
  eq,
  inArray,
  exists,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Db } from "../../db/pool";
import { insertSelectValues } from "../../db/postgres/query-builders";
import { materializedCtesSQL } from "../../db/materialized-cte";
import {
  chatLogs,
  chatLogEvaluations as evaluations,
  ltiChatLogSubjects as logSubjects,
  chatConversations as conversations,
  ltiConversationScopes as conversationScopes,
  chatConversationTurns as turns,
  videoCourses as courses,
  lmsCourses,
  teachingConnections,
  courseQuestions as questions,
  courseQuestionReplies as replies,
  courseQuestionLtiVotes as votes,
  courseQaModeration as moderation,
  ltiMaterialOperations as materialOperations,
  ltiCourseTagOperations as tagOperations,
  ltiReportAccesses as reportAccesses,
  ltiCredentials as credentials,
  ltiOperationReservations as reservations,
} from "../../db/schema";
import {
  memoryCheckpoints,
  memoryBlobs,
  memoryWrites,
} from "../../db/postgres/checkpoint-tables";
import { privacyIdentityPrefixes } from "../../application/subject-identity";
import {
  privacyCourseContext,
  privacyRecentContext,
  privacyReportContext,
  privacyRecordAllowed,
  privacyCursorFailure,
  privacyRecordCursor,
  privacyErasurePlan,
  privacyOperationBarriers,
} from "../../application/privacy-policy";
import { privacyDrizzleLogic as logic } from "../privacy-policy-sql";
import { PRIVACY_CONTEXT_PAGE_SIZE } from "../../application/privacy";
import {
  privacyContextCollections,
  privacyContextPage,
  privacyExportPage,
  PRIVACY_EXPORT_CHUNK_CHARACTERS,
} from "../../application/privacy";
import { reservationKeySql } from "./operation-reservations";
import { z } from "zod";
import { ApiError } from "../../shared/errors";
import {
  ORPHAN_CONTEXT,
  privacyRequest,
  type PrivacyInstallation,
  type PrivacySubject as Subject,
} from "../../shared/privacy";
export {
  ORPHAN_CONTEXT,
  privacyCollections,
  privacyRequest,
  privacySubject,
  type PrivacyInstallation,
} from "../../shared/privacy";
function privacyQueries(
  db: Db,
  installation: PrivacyInstallation,
  subject: Subject,
  contexts: string[] | null,
) {
  const prefix = privacyIdentityPrefixes(subject);
  const contextFor = (course: SQLWrapper) =>
    privacyCourseContext(
      sql`${db
        .select({ context: lmsCourses.contextId })
        .from(lmsCourses)
        .where(
          and(
            eq(lmsCourses.installationId, installation.id),
            eq(lmsCourses.courseId, course),
          ),
        )
        .orderBy(lmsCourses.id)
        .limit(1)}`,
      sql`${db
        .select({ context: teachingConnections.contextId })
        .from(teachingConnections)
        .where(
          and(
            eq(teachingConnections.provider, "moodle"),
            eq(teachingConnections.installationId, installation.id),
            eq(teachingConnections.courseId, course),
          ),
        )
        .orderBy(sql`${teachingConnections.contextId} COLLATE "C"`)
        .limit(1)}`,
      logic,
    );
  const reportContext = privacyReportContext(
    exists(
      db
        .select({ id: lmsCourses.id })
        .from(lmsCourses)
        .where(
          and(
            eq(lmsCourses.installationId, installation.id),
            eq(lmsCourses.courseId, reportAccesses.courseId),
            eq(lmsCourses.contextId, reportAccesses.contextId),
          ),
        ),
    ),
    exists(
      db
        .select({ id: teachingConnections.id })
        .from(teachingConnections)
        .where(
          and(
            eq(teachingConnections.provider, "moodle"),
            eq(teachingConnections.installationId, installation.id),
            eq(teachingConnections.courseId, reportAccesses.courseId),
            eq(teachingConnections.contextId, reportAccesses.contextId),
          ),
        ),
    ),
    sql`${reportAccesses.contextId}`,
    logic,
  );
  const author = (course: SQLWrapper) =>
    sql`encode(sha256(convert_to(${prefix.qa}||${course}::text||']','UTF8')),'hex')`;
  const scoped = (where: SQL, context: SQL) =>
    privacyRecordAllowed(
      where,
      sql`${contexts === null}`,
      contexts === null ? sql`false` : inArray(context, contexts),
      logic,
    );
  const fields = (key: SQLWrapper, context: SQL, data: SQL) => ({
    key: sql`${key}`.as("record_key"),
    context: sql<string>`${context}`.as("record_context"),
    data: data.as("record_data"),
  });
  const logContext = contextFor(chatLogs.courseId),
    conversationContext = contextFor(conversations.courseId),
    courseContext = contextFor(courses.id);
  const historyContext = privacyRecentContext(
    sql`${credentials.payload}->>'contextId'`,
    contextFor(
      sql`CASE WHEN ${credentials.payload}->>'courseId' ~ '^[1-9][0-9]{0,17}$' THEN (${credentials.payload}->>'courseId')::bigint END`,
    ),
    logic,
  );
  return {
    logs: {
      cast: "bigint" as const,
      query: db
        .select(
          fields(
            chatLogs.id,
            logContext,
            sql`jsonb_build_object('question',${chatLogs.question},'answer',${chatLogs.response},'feedback',${chatLogs.feedback},'retrievedContexts',${chatLogs.retrievedContexts},'createdAt',${chatLogs.createdAt},'resourceVideoIds',${logSubjects.resourceVideoIds},'registrationId',${logSubjects.registrationId},'contextId',${logSubjects.contextId},'questionAuthor',${logSubjects.classroomAuthor})`,
          ),
        )
        .from(chatLogs)
        .innerJoin(
          logSubjects,
          and(
            eq(logSubjects.chatLogId, chatLogs.id),
            eq(logSubjects.subjectKey, subject.subjectKey),
          ),
        )
        .where(scoped(sql`true`, logContext))
        .as("privacy_logs"),
    },
    evaluations: {
      cast: "bigint" as const,
      query: db
        .select(
          fields(
            evaluations.id,
            logContext,
            sql`jsonb_build_object('status',${evaluations.status},'faithfulness',${evaluations.faithfulness},'answerRelevancy',${evaluations.answerRelevancy},'contextPrecision',${evaluations.contextPrecision},'createdAt',${evaluations.createdAt},'evaluatedAt',${evaluations.evaluatedAt})`,
          ),
        )
        .from(chatLogs)
        .innerJoin(
          logSubjects,
          and(
            eq(logSubjects.chatLogId, chatLogs.id),
            eq(logSubjects.subjectKey, subject.subjectKey),
          ),
        )
        .innerJoin(evaluations, eq(evaluations.chatLogId, chatLogs.id))
        .where(scoped(sql`true`, logContext))
        .as("privacy_evaluations"),
    },
    conversations: {
      cast: "text" as const,
      query: db
        .select(
          fields(
            sql`'thread:'||${conversations.threadId}`,
            conversationContext,
            sql`jsonb_build_object('conversationId',${conversations.conversationId},'title',${conversations.title},'createdAt',${conversations.createdAt},'updatedAt',${conversations.updatedAt},'expiresAt',${conversations.expiresAt},'resourceVideoIds',${conversationScopes.resourceVideoIds})`,
          ),
        )
        .from(conversations)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, subject.subjectKey),
          ),
        )
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_conversations"),
    },
    turns: {
      cast: "bigint" as const,
      query: db
        .select(
          fields(
            turns.id,
            conversationContext,
            sql`jsonb_build_object('conversationId',${conversations.conversationId},'question',${turns.question},'answer',${turns.response},'createdAt',${turns.createdAt})`,
          ),
        )
        .from(conversations)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, subject.subjectKey),
          ),
        )
        .innerJoin(turns, eq(turns.threadId, conversations.threadId))
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_turns"),
    },
    questions: {
      cast: "uuid" as const,
      query: db
        .select(
          fields(
            questions.id,
            courseContext,
            sql`jsonb_build_object('questionId',${questions.id},'title',${questions.title},'body',${questions.body},'featured',${questions.featured},'sourceVideoId',${questions.sourceVideoId},'createdAt',${questions.createdAt},'updatedAt',${questions.updatedAt})`,
          ),
        )
        .from(courses)
        .innerJoin(questions, eq(questions.courseId, courses.id))
        .where(
          scoped(eq(questions.ltiAuthorId, author(courses.id)), courseContext),
        )
        .as("privacy_questions"),
    },
    replies: {
      cast: "uuid" as const,
      query: db
        .select(
          fields(
            replies.id,
            courseContext,
            sql`jsonb_build_object('questionId',${questions.id},'replyId',${replies.id},'body',${replies.body},'createdAt',${replies.createdAt},'updatedAt',${replies.updatedAt})`,
          ),
        )
        .from(courses)
        .innerJoin(questions, eq(questions.courseId, courses.id))
        .innerJoin(replies, eq(replies.questionId, questions.id))
        .where(
          scoped(eq(replies.ltiAuthorId, author(courses.id)), courseContext),
        )
        .as("privacy_replies"),
    },
    votes: {
      cast: "uuid" as const,
      query: db
        .select(
          fields(
            votes.questionId,
            courseContext,
            sql`jsonb_build_object('questionId',${questions.id},'createdAt',${votes.createdAt})`,
          ),
        )
        .from(courses)
        .innerJoin(questions, eq(questions.courseId, courses.id))
        .innerJoin(votes, eq(votes.questionId, questions.id))
        .where(scoped(eq(votes.ltiAuthorId, author(courses.id)), courseContext))
        .as("privacy_votes"),
    },
    moderation: {
      cast: "uuid" as const,
      query: db
        .select(
          fields(
            moderation.id,
            courseContext,
            sql`jsonb_build_object('questionId',${moderation.questionId},'replyId',${moderation.replyId},'action',${moderation.action},'createdAt',${moderation.createdAt})`,
          ),
        )
        .from(courses)
        .innerJoin(moderation, eq(moderation.courseId, courses.id))
        .where(
          scoped(eq(moderation.ltiActorId, author(courses.id)), courseContext),
        )
        .as("privacy_moderation"),
    },
    material_operations: {
      cast: "uuid" as const,
      query: db
        .select(
          fields(
            materialOperations.id,
            courseContext,
            sql`jsonb_build_object('operationId',${materialOperations.id},'action',${materialOperations.action},'sourceGeneration',${materialOperations.sourceGeneration},'requestHash',${materialOperations.requestHash},'beforeRevision',${materialOperations.beforeRevision},'afterRevision',${materialOperations.afterRevision},'createdAt',${materialOperations.createdAt})`,
          ),
        )
        .from(courses)
        .innerJoin(
          materialOperations,
          eq(materialOperations.courseId, courses.id),
        )
        .where(
          scoped(
            eq(materialOperations.actorKey, subject.subjectKey),
            courseContext,
          ),
        )
        .as("privacy_material_operations"),
    },
    tag_operations: {
      cast: "uuid" as const,
      query: db
        .select(
          fields(
            tagOperations.id,
            courseContext,
            sql`jsonb_build_object('operationId',${tagOperations.id},'action',${tagOperations.action},'requestHash',${tagOperations.requestHash},'createdAt',${tagOperations.createdAt})`,
          ),
        )
        .from(courses)
        .innerJoin(tagOperations, eq(tagOperations.courseId, courses.id))
        .where(
          scoped(eq(tagOperations.actorKey, subject.subjectKey), courseContext),
        )
        .as("privacy_tag_operations"),
    },
    report_accesses: {
      cast: "uuid" as const,
      query: db
        .select(
          fields(
            reportAccesses.id,
            reportContext,
            sql`jsonb_build_object('accessId',${reportAccesses.id},'from',${reportAccesses.fromDate},'to',${reportAccesses.toDate},'resourceCount',${reportAccesses.resourceCount},'scopeHash',${reportAccesses.scopeHash},'createdAt',${reportAccesses.createdAt})`,
          ),
        )
        .from(courses)
        .innerJoin(reportAccesses, eq(reportAccesses.courseId, courses.id))
        .where(
          scoped(
            and(
              eq(reportAccesses.actorKey, subject.subjectKey),
              eq(reportAccesses.installationId, installation.id),
            )!,
            reportContext,
          ),
        )
        .as("privacy_report_accesses"),
    },
    recent_history: {
      cast: "text" as const,
      query: db
        .select(
          fields(
            credentials.id,
            historyContext,
            sql`jsonb_build_object('turns',${credentials.payload}->'turns','expiresAt',${credentials.expiresAt})`,
          ),
        )
        .from(credentials)
        .where(
          scoped(
            and(
              eq(credentials.kind, "lti-history"),
              eq(
                sql`${credentials.payload}->>'registrationId'`,
                subject.registrationId,
              ),
              eq(
                sql`${credentials.payload}->>'subjectHash'`,
                subject.subjectHash,
              ),
            )!,
            historyContext,
          ),
        )
        .as("privacy_recent_history"),
    },
    checkpoints: {
      cast: "text" as const,
      query: db
        .select(
          fields(
            sql`jsonb_build_array(${memoryCheckpoints.threadId},${memoryCheckpoints.namespace},${memoryCheckpoints.checkpointId})::text`,
            conversationContext,
            sql`jsonb_build_object('conversationId',${conversations.conversationId},'namespace',${memoryCheckpoints.namespace},'checkpointId',${memoryCheckpoints.checkpointId},'parentCheckpointId',${memoryCheckpoints.parentId},'checkpoint',${memoryCheckpoints.checkpoint},'metadata',${memoryCheckpoints.metadata})`,
          ),
        )
        .from(conversations)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, subject.subjectKey),
          ),
        )
        .innerJoin(
          memoryCheckpoints,
          eq(memoryCheckpoints.threadId, conversations.threadId),
        )
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_checkpoints"),
    },
    checkpoint_blobs: {
      cast: "text" as const,
      query: db
        .select(
          fields(
            sql`jsonb_build_array(${memoryBlobs.threadId},${memoryBlobs.namespace},${memoryBlobs.channel},${memoryBlobs.version})::text`,
            conversationContext,
            sql`jsonb_build_object('conversationId',${conversations.conversationId},'namespace',${memoryBlobs.namespace},'channel',${memoryBlobs.channel},'version',${memoryBlobs.version},'type',${memoryBlobs.type},'encoding','base64','data',encode(${memoryBlobs.blob},'base64'))`,
          ),
        )
        .from(conversations)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, subject.subjectKey),
          ),
        )
        .innerJoin(
          memoryBlobs,
          eq(memoryBlobs.threadId, conversations.threadId),
        )
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_checkpoint_blobs"),
    },
    checkpoint_writes: {
      cast: "text" as const,
      query: db
        .select(
          fields(
            sql`jsonb_build_array(${memoryWrites.threadId},${memoryWrites.namespace},${memoryWrites.checkpointId},${memoryWrites.taskId},${memoryWrites.index})::text`,
            conversationContext,
            sql`jsonb_build_object('conversationId',${conversations.conversationId},'namespace',${memoryWrites.namespace},'checkpointId',${memoryWrites.checkpointId},'index',${memoryWrites.index},'channel',${memoryWrites.channel},'type',${memoryWrites.type},'encoding','base64','data',encode(${memoryWrites.blob},'base64'))`,
          ),
        )
        .from(conversations)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, subject.subjectKey),
          ),
        )
        .innerJoin(
          memoryWrites,
          eq(memoryWrites.threadId, conversations.threadId),
        )
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_checkpoint_writes"),
    },
  };
}
/** Export one record as bounded UTF-8 fragments, freezing its JSON once. */
export async function exportPrivacyPart(
  db: Db,
  installation: PrivacyInstallation,
  subject: Subject,
  input: Extract<z.infer<typeof privacyRequest>, { action: "export" }>,
) {
  const d = privacyQueries(db, installation, subject, input.contexts)[
      input.collection
    ],
    point = input.cursor?.record,
    id = privacyRecordCursor(input.cursor);
  const failure = privacyCursorFailure(
    input.collection,
    d.cast === "bigint" ? "integer" : d.cast === "uuid" ? "uuid" : "opaque",
    id,
    (value) => z.uuid().safeParse(value).success,
  );
  if (failure === "retiredConversation")
    throw new ApiError(
      409,
      "CONFLICT",
      "Conversation export identifiers changed. Restart the export.",
    );
  if (failure === "invalid")
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid export cursor.");
  const comparison = id
    ? point
      ? sql`${d.query.key}=${id}::${sql.raw(d.cast)}`
      : sql`${d.query.key}>${id}::${sql.raw(d.cast)}`
    : undefined;
  const source = db
    .select({
      id: sql<string>`${d.query.key}::text`.as("id"),
      context: sql<string>`${d.query.context}`.as("context"),
      data: sql<string>`${d.query.data}::text`.as("data"),
    })
    .from(d.query)
    .where(comparison)
    .orderBy(d.query.key)
    .limit(1);
  const candidate = db.$with("candidate").as(source);
  const output = db
    .select({
      id: candidate.id,
      context: candidate.context,
      chunk:
        sql<string>`substring(${candidate.data} FROM ${point?.offset ?? 0}::int+1 FOR ${PRIVACY_EXPORT_CHUNK_CHARACTERS})`.as(
          "chunk",
        ),
      total: sql<number>`length(${candidate.data})::int`.as("total"),
      revision:
        sql<string>`encode(sha256(convert_to(${candidate.data},'UTF8')),'hex')`.as(
          "revision",
        ),
    })
    .from(candidate);
  const rows = await db.execute<{
    id: string;
    context: string;
    chunk: string;
    total: number;
    revision: string;
  }>(materializedCtesSQL([{ name: "candidate", source }], output));
  const result = privacyExportPage(rows.rows[0], point);
  if ("changed" in result)
    throw new ApiError(409, "CONFLICT", "Data changed. Restart the export.");
  return result;
}
export async function subjectPrivacyContexts(
  db: Db,
  installation: PrivacyInstallation,
  subject: Subject,
  after = "",
  contexts: string[] | null = null,
) {
  const defs = privacyQueries(db, installation, subject, contexts);
  const sources = privacyContextCollections.map((name) =>
    db.select({ context: defs[name].query.context }).from(defs[name].query),
  );
  const combined = unionAll(sources[0], sources[1], ...sources.slice(2)).as(
    "contexts",
  );
  const unique = db
    .selectDistinct({ context: combined.context })
    .from(combined)
    .as("unique_contexts");
  const rows = await db
    .select({ context: unique.context })
    .from(unique)
    .where(sql`${unique.context} COLLATE "C">${after}`)
    .orderBy(sql`${unique.context} COLLATE "C"`)
    .limit(PRIVACY_CONTEXT_PAGE_SIZE + 1);
  return privacyContextPage(rows, (row) => row.context);
}
/** Called under the owner's exclusive lock and the encompassing recovery transaction. */
export async function erasePrivacyData(
  db: Db,
  installation: PrivacyInstallation,
  subject: Subject,
  contexts: string[],
) {
  const defs = privacyQueries(db, installation, subject, contexts),
    result: Record<string, number> = {};
  const ids = (name: keyof typeof defs) =>
    db.select({ id: defs[name].query.key }).from(defs[name].query);
  const execute = async (name: string, query: PromiseLike<unknown[]>) => {
    result[name] = (await query).length;
  };
  // Feedback and authentication revocation share one statement. Its modifying
  // CTE carries revoked session IDs without exposing credentials in exports.
  const revoked = db.$with("revoked").as(
    db
      .delete(credentials)
      .where(
        and(
          eq(credentials.kind, "session"),
          eq(
            sql`${credentials.payload}->>'registrationId'`,
            subject.registrationId,
          ),
          eq(sql`${credentials.payload}->>'subjectHash'`, subject.subjectHash),
          inArray(
            sql`coalesce(${credentials.payload}->>'contextId',${ORPHAN_CONTEXT})`,
            contexts,
          ),
        ),
      )
      .returning({ id: credentials.id }),
  );
  const logIds = db
    .select({ id: sql<string>`${defs.logs.query.key}::text` })
    .from(defs.logs.query);
  const feedback = db.$with("feedback").as(
    db
      .delete(credentials)
      .where(
        and(
          eq(credentials.kind, "lti-feedback"),
          or(
            inArray(
              sql`${credentials.payload}->>'sessionHash'`,
              db.select({ id: revoked.id }).from(revoked),
            ),
            inArray(sql`${credentials.payload}->>'logId'`, logIds),
          ),
        ),
      )
      .returning({ id: credentials.id }),
  );
  const revokedCount = db.select({ count: sql`count(*)` }).from(revoked),
    feedbackCount = db.select({ count: sql`count(*)` }).from(feedback);
  const [counts] = await db
    .with(revoked, feedback)
    .select({ sessions: sql`${revokedCount}`, feedback: sql`${feedbackCount}` })
    .from(sql`(VALUES(1)) input`);
  result.sessions = Number(counts.sessions);
  result.feedback = Number(counts.feedback);
  for (const effect of privacyErasurePlan()) {
    switch (effect.target) {
      case "sessions":
      case "feedback":
        break;
      case "recentHistory":
        await execute(
          effect.target,
          db
            .delete(credentials)
            .where(inArray(credentials.id, ids("recent_history")))
            .returning({ id: credentials.id }),
        );
        break;
      case "conversations": {
        // Export cursors deliberately use opaque thread: IDs; erasure addresses the
        // underlying thread directly through its verified subject/scope relation.
        const query = defs.conversations.query;
        await execute(
          effect.target,
          db
            .delete(conversations)
            .where(
              inArray(
                sql`'thread:'||${conversations.threadId}`,
                db.select({ id: query.key }).from(query),
              ),
            )
            .returning({ id: conversations.threadId }),
        );
        break;
      }
      case "logs":
        await execute(
          effect.target,
          db
            .delete(chatLogs)
            .where(inArray(chatLogs.id, ids("logs")))
            .returning({ id: chatLogs.id }),
        );
        break;
      case "questions": {
        const f = effect.fields;
        await execute(
          effect.target,
          db
            .update(questions)
            .set({
              title: f.title,
              body: f.body,
              ltiAuthorId: f.author,
              ltiInstructor: f.instructor,
              featured: f.featured,
              updatedAt: sql`now()`,
            })
            .where(inArray(questions.id, ids("questions")))
            .returning({ id: questions.id }),
        );
        break;
      }
      case "replies": {
        const f = effect.fields;
        await execute(
          effect.target,
          db
            .update(replies)
            .set({
              body: f.body,
              ltiAuthorId: f.author,
              ltiInstructor: f.instructor,
              updatedAt: sql`now()`,
            })
            .where(inArray(replies.id, ids("replies")))
            .returning({ id: replies.id }),
        );
        break;
      }
      case "votes":
        await execute(
          effect.target,
          db
            .delete(votes)
            .where(
              and(
                inArray(votes.questionId, ids("votes")),
                eq(
                  votes.ltiAuthorId,
                  sql`encode(sha256(convert_to(${privacyIdentityPrefixes(subject).qa}||${db.select({ id: questions.courseId }).from(questions).where(eq(questions.id, votes.questionId))}::text||']','UTF8')),'hex')`,
                ),
              ),
            )
            .returning({ id: votes.questionId }),
        );
        break;
      case "moderation":
        await execute(
          effect.target,
          db
            .update(moderation)
            .set({ ltiActorId: effect.actor })
            .where(inArray(moderation.id, ids("moderation")))
            .returning({ id: moderation.id }),
        );
        break;
      case "materialOperations":
      case "tagOperations": {
        const barrier = privacyOperationBarriers.find(
            (b) => b.count === effect.target,
          )!,
          d = defs[barrier.collection],
          table =
            effect.target === "materialOperations"
              ? materialOperations
              : tagOperations;
        await db
          .insert(reservations)
          .select(
            db
              .select(
                insertSelectValues(reservations, {
                  key: reservationKeySql(
                    barrier.operation,
                    sql`${d.query.key}`,
                  ),
                }),
              )
              .from(d.query)
              .orderBy(sql`1`),
          )
          .onConflictDoNothing();
        await execute(
          effect.target,
          db
            .delete(table)
            .where(
              inArray(table.id, db.select({ id: d.query.key }).from(d.query)),
            )
            .returning({ id: table.id }),
        );
        break;
      }
      case "reportAccesses":
        await execute(
          effect.target,
          db
            .delete(reportAccesses)
            .where(inArray(reportAccesses.id, ids("report_accesses")))
            .returning({ id: reportAccesses.id }),
        );
        break;
    }
  }
  return result;
}
