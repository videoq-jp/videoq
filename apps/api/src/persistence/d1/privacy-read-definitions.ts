import {
  and,
  eq,
  inArray,
  isNull,
  exists,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  privacyCourseContext,
  privacyRecentContext,
  privacyReportContext,
  privacyRecordAllowed,
} from "../../application/privacy-policy";
import { privacyDrizzleLogic } from "../privacy-policy-sql";
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
  conversationCheckpoints as checkpoints,
  conversationCheckpointWrites as writes,
} from "../../db/schema/sqlite";
import type { D1PrivacySubjectScope } from "./privacy-scope";
// These closed literals keep repeated per-collection context queries below D1's
// binding limit. Every request value lives in the single parameter CTE.
const logic = { ...privacyDrizzleLogic, orphan: () => sql`'@orphan'` };
export const binaryNames = [
  "conversationId",
  "namespace",
  "checkpoint_id",
  "parent_id",
  "checkpoint_type",
  "checkpoint",
  "metadata_type",
  "metadata",
  "task_id",
  "task_path",
  "idx",
  "channel",
  "value_type",
  "value",
] as const;
type BinaryName = (typeof binaryNames)[number];
function fields(
  key: SQLWrapper,
  context: SQL,
  data: SQL,
  binary: Partial<Record<BinaryName, SQLWrapper>> = {},
  authorKey: SQLWrapper = sql`NULL`,
) {
  const columns = Object.fromEntries(
    binaryNames.map((name) => [
      name,
      sql`${binary[name] ?? sql`NULL`}`.as("privacy_binary_" + name),
    ]),
  ) as Record<BinaryName, SQL.Aliased<unknown>>;
  return {
    key: sql`${key}`.as("privacy_record_key"),
    context: sql<string>`${context}`.as("privacy_record_context"),
    data: sql<string>`${data}`.as("privacy_record_data"),
    authorKey: sql`${authorKey}`.as("privacy_author_key"),
    ...columns,
  };
}
export function privacyReadQueries(scope: D1PrivacySubjectScope) {
  const { db, p } = scope;
  const contextFor = (course: SQLWrapper) =>
    privacyCourseContext(
      sql`${db
        .select({ context: lmsCourses.contextId })
        .from(lmsCourses)
        .where(
          and(
            eq(lmsCourses.installationId, p.installation),
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
            eq(teachingConnections.provider, sql`'moodle'`),
            eq(teachingConnections.installationId, p.installation),
            eq(teachingConnections.courseId, course),
          ),
        )
        .orderBy(sql`${teachingConnections.contextId} COLLATE BINARY`)
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
            eq(lmsCourses.installationId, p.installation),
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
            eq(teachingConnections.provider, sql`'moodle'`),
            eq(teachingConnections.installationId, p.installation),
            eq(teachingConnections.courseId, reportAccesses.courseId),
            eq(teachingConnections.contextId, reportAccesses.contextId),
          ),
        ),
    ),
    sql`${reportAccesses.contextId}`,
    logic,
  );
  const author = (course: SQLWrapper) =>
    db
      .select({ value: sql<string>`json_extract(a.value,'$.author')` })
      .from(sql`json_each(${p.authors}) a`)
      .where(eq(sql`json_extract(a.value,'$.id')`, course));
  const scoped = (where: SQL, context: SQL) =>
    privacyRecordAllowed(
      where,
      isNull(p.contexts),
      inArray(
        context,
        db.select({ value: sql`value` }).from(sql`json_each(${p.contexts})`),
      ),
      logic,
    );
  const logContext = contextFor(chatLogs.courseId),
    conversationContext = contextFor(conversations.courseId),
    courseContext = contextFor(courses.id);
  const historyContext = privacyRecentContext(
    sql`json_extract(${credentials.payload},'$.contextId')`,
    contextFor(
      sql`CASE WHEN CAST(CAST(json_extract(${credentials.payload},'$.courseId') AS INTEGER) AS TEXT)=CAST(json_extract(${credentials.payload},'$.courseId') AS TEXT) THEN CAST(json_extract(${credentials.payload},'$.courseId') AS INTEGER) END`,
    ),
    logic,
  );
  return {
    logs: {
      ...privacyCollectionShape("logs"),
      query: db
        .select(
          fields(
            chatLogs.id,
            logContext,
            sql`json_object('question',${chatLogs.question},'answer',json(${chatLogs.response}),'feedback',${chatLogs.feedback},'retrievedContexts',json(${chatLogs.retrievedContexts}),'createdAt',${chatLogs.createdAt},'resourceVideoIds',json(${logSubjects.resourceVideoIds}),'registrationId',${logSubjects.registrationId},'contextId',${logSubjects.contextId},'questionAuthor',json(${logSubjects.classroomAuthor}))`,
          ),
        )
        .from(p)
        .innerJoin(chatLogs, sql`true`)
        .innerJoin(
          logSubjects,
          and(
            eq(logSubjects.chatLogId, chatLogs.id),
            eq(logSubjects.subjectKey, p.subject),
          ),
        )
        .where(scoped(sql`true`, logContext))
        .as("privacy_logs"),
    },
    evaluations: {
      ...privacyCollectionShape("evaluations"),
      query: db
        .select(
          fields(
            evaluations.id,
            logContext,
            sql`json_object('status',${evaluations.status},'faithfulness',${evaluations.faithfulness},'answerRelevancy',${evaluations.answerRelevancy},'contextPrecision',${evaluations.contextPrecision},'createdAt',${evaluations.createdAt},'evaluatedAt',${evaluations.evaluatedAt})`,
          ),
        )
        .from(p)
        .innerJoin(chatLogs, sql`true`)
        .innerJoin(
          logSubjects,
          and(
            eq(logSubjects.chatLogId, chatLogs.id),
            eq(logSubjects.subjectKey, p.subject),
          ),
        )
        .innerJoin(evaluations, eq(evaluations.chatLogId, chatLogs.id))
        .where(scoped(sql`true`, logContext))
        .as("privacy_evaluations"),
    },
    conversations: {
      ...privacyCollectionShape("conversations"),
      query: db
        .select(
          fields(
            sql`'thread:'||${conversations.threadId}`,
            conversationContext,
            sql`json_object('conversationId',${conversations.conversationId},'title',${conversations.title},'createdAt',${conversations.createdAt},'updatedAt',${conversations.updatedAt},'expiresAt',${conversations.expiresAt},'resourceVideoIds',json(${conversationScopes.resourceVideoIds}))`,
          ),
        )
        .from(p)
        .innerJoin(conversations, sql`true`)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, p.subject),
          ),
        )
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_conversations"),
    },
    turns: {
      ...privacyCollectionShape("turns"),
      query: db
        .select(
          fields(
            turns.id,
            conversationContext,
            sql`json_object('conversationId',${conversations.conversationId},'question',${turns.question},'answer',json(${turns.response}),'createdAt',${turns.createdAt})`,
          ),
        )
        .from(p)
        .innerJoin(conversations, sql`true`)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, p.subject),
          ),
        )
        .innerJoin(turns, eq(turns.threadId, conversations.threadId))
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_turns"),
    },
    questions: {
      ...privacyCollectionShape("questions"),
      query: db
        .select(
          fields(
            questions.id,
            courseContext,
            sql`json_object('questionId',${questions.id},'title',${questions.title},'body',${questions.body},'featured',json(CASE WHEN ${questions.featured}=1 THEN 'true' ELSE 'false' END),'sourceVideoId',${questions.sourceVideoId},'createdAt',${questions.createdAt},'updatedAt',${questions.updatedAt})`,
          ),
        )
        .from(p)
        .innerJoin(courses, sql`true`)
        .innerJoin(questions, eq(questions.courseId, courses.id))
        .where(
          scoped(eq(questions.ltiAuthorId, author(courses.id)), courseContext),
        )
        .as("privacy_questions"),
    },
    replies: {
      ...privacyCollectionShape("replies"),
      query: db
        .select(
          fields(
            replies.id,
            courseContext,
            sql`json_object('questionId',${questions.id},'replyId',${replies.id},'body',${replies.body},'createdAt',${replies.createdAt},'updatedAt',${replies.updatedAt})`,
          ),
        )
        .from(p)
        .innerJoin(courses, sql`true`)
        .innerJoin(questions, eq(questions.courseId, courses.id))
        .innerJoin(replies, eq(replies.questionId, questions.id))
        .where(
          scoped(eq(replies.ltiAuthorId, author(courses.id)), courseContext),
        )
        .as("privacy_replies"),
    },
    votes: {
      ...privacyCollectionShape("votes"),
      query: db
        .select(
          fields(
            votes.questionId,
            courseContext,
            sql`json_object('questionId',${questions.id},'createdAt',${votes.createdAt})`,
            {},
            votes.ltiAuthorId,
          ),
        )
        .from(p)
        .innerJoin(courses, sql`true`)
        .innerJoin(questions, eq(questions.courseId, courses.id))
        .innerJoin(votes, eq(votes.questionId, questions.id))
        .where(scoped(eq(votes.ltiAuthorId, author(courses.id)), courseContext))
        .as("privacy_votes"),
    },
    moderation: {
      ...privacyCollectionShape("moderation"),
      query: db
        .select(
          fields(
            moderation.id,
            courseContext,
            sql`json_object('questionId',${moderation.questionId},'replyId',${moderation.replyId},'action',${moderation.action},'createdAt',${moderation.createdAt})`,
          ),
        )
        .from(p)
        .innerJoin(courses, sql`true`)
        .innerJoin(moderation, eq(moderation.courseId, courses.id))
        .where(
          scoped(eq(moderation.ltiActorId, author(courses.id)), courseContext),
        )
        .as("privacy_moderation"),
    },
    material_operations: {
      ...privacyCollectionShape("material_operations"),
      query: db
        .select(
          fields(
            materialOperations.id,
            courseContext,
            sql`json_object('operationId',${materialOperations.id},'action',${materialOperations.action},'sourceGeneration',${materialOperations.sourceGeneration},'requestHash',${materialOperations.requestHash},'beforeRevision',${materialOperations.beforeRevision},'afterRevision',${materialOperations.afterRevision},'createdAt',${materialOperations.createdAt})`,
          ),
        )
        .from(p)
        .innerJoin(courses, sql`true`)
        .innerJoin(
          materialOperations,
          eq(materialOperations.courseId, courses.id),
        )
        .where(
          scoped(eq(materialOperations.actorKey, p.subject), courseContext),
        )
        .as("privacy_material_operations"),
    },
    tag_operations: {
      ...privacyCollectionShape("tag_operations"),
      query: db
        .select(
          fields(
            tagOperations.id,
            courseContext,
            sql`json_object('operationId',${tagOperations.id},'action',${tagOperations.action},'requestHash',${tagOperations.requestHash},'createdAt',${tagOperations.createdAt})`,
          ),
        )
        .from(p)
        .innerJoin(courses, sql`true`)
        .innerJoin(tagOperations, eq(tagOperations.courseId, courses.id))
        .where(scoped(eq(tagOperations.actorKey, p.subject), courseContext))
        .as("privacy_tag_operations"),
    },
    report_accesses: {
      ...privacyCollectionShape("report_accesses"),
      query: db
        .select(
          fields(
            reportAccesses.id,
            reportContext,
            sql`json_object('accessId',${reportAccesses.id},'from',${reportAccesses.fromDate},'to',${reportAccesses.toDate},'resourceCount',${reportAccesses.resourceCount},'scopeHash',${reportAccesses.scopeHash},'createdAt',${reportAccesses.createdAt})`,
          ),
        )
        .from(p)
        .innerJoin(courses, sql`true`)
        .innerJoin(reportAccesses, eq(reportAccesses.courseId, courses.id))
        .where(
          scoped(
            and(
              eq(reportAccesses.actorKey, p.subject),
              eq(reportAccesses.installationId, p.installation),
            )!,
            reportContext,
          ),
        )
        .as("privacy_report_accesses"),
    },
    recent_history: {
      ...privacyCollectionShape("recent_history"),
      query: db
        .select(
          fields(
            credentials.id,
            historyContext,
            sql`json_object('turns',json(${credentials.payload} -> '$.turns'),'expiresAt',${credentials.expiresAt})`,
          ),
        )
        .from(p)
        .innerJoin(credentials, eq(credentials.kind, sql`'lti-history'`))
        .where(
          scoped(
            and(
              eq(
                sql`json_extract(${credentials.payload},'$.registrationId')`,
                p.registration,
              ),
              eq(
                sql`json_extract(${credentials.payload},'$.subjectHash')`,
                p.subjectHash,
              ),
            )!,
            historyContext,
          ),
        )
        .as("privacy_recent_history"),
    },
    checkpoints: {
      ...privacyCollectionShape("checkpoints"),
      query: db
        .select(
          fields(
            sql`json_array(${checkpoints.threadId},${checkpoints.namespace},${checkpoints.checkpointId})`,
            conversationContext,
            sql`NULL`,
            {
              conversationId: conversations.conversationId,
              namespace: checkpoints.namespace,
              checkpoint_id: checkpoints.checkpointId,
              parent_id: checkpoints.parentId,
              checkpoint_type: checkpoints.checkpointType,
              checkpoint: checkpoints.checkpoint,
              metadata_type: checkpoints.metadataType,
              metadata: checkpoints.metadata,
            },
          ),
        )
        .from(p)
        .innerJoin(conversations, sql`true`)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, p.subject),
          ),
        )
        .innerJoin(
          checkpoints,
          eq(checkpoints.threadId, conversations.threadId),
        )
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_checkpoints"),
    },
    checkpoint_blobs: {
      ...privacyCollectionShape("checkpoint_blobs"),
      query: db
        .select(
          fields(
            sql`'thread:'||${conversations.threadId}`,
            conversationContext,
            sql`'{}'`,
          ),
        )
        .from(p)
        .innerJoin(conversations, sql`true`)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, p.subject),
          ),
        )
        .where(scoped(sql`false`, conversationContext))
        .as("privacy_blobs"),
    },
    checkpoint_writes: {
      ...privacyCollectionShape("checkpoint_writes"),
      query: db
        .select(
          fields(
            sql`json_array(${writes.threadId},${writes.namespace},${writes.checkpointId},${writes.taskId},${writes.index})`,
            conversationContext,
            sql`NULL`,
            {
              conversationId: conversations.conversationId,
              namespace: writes.namespace,
              checkpoint_id: writes.checkpointId,
              task_id: writes.taskId,
              task_path: writes.taskPath,
              idx: writes.index,
              channel: writes.channel,
              value_type: writes.valueType,
              value: writes.value,
            },
          ),
        )
        .from(p)
        .innerJoin(conversations, sql`true`)
        .innerJoin(
          conversationScopes,
          and(
            eq(conversationScopes.threadId, conversations.threadId),
            eq(conversationScopes.subjectKey, p.subject),
          ),
        )
        .innerJoin(writes, eq(writes.threadId, conversations.threadId))
        .where(scoped(sql`true`, conversationContext))
        .as("privacy_writes"),
    },
  };
}

export function privacyCollectionShape(
  name: (typeof import("../../shared/privacy").privacyCollections)[number],
) {
  const cast = (["logs", "evaluations", "turns"] as string[]).includes(name)
    ? "bigint"
    : (
          [
            "questions",
            "replies",
            "votes",
            "moderation",
            "material_operations",
            "tag_operations",
            "report_accesses",
          ] as string[]
        ).includes(name)
      ? "uuid"
      : "text";
  const binary =
    name === "checkpoints"
      ? "checkpoint"
      : name === "checkpoint_writes"
        ? "write"
        : undefined;
  return { cast, binary } as const;
}
