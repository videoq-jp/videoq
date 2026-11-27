import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  and,
  or,
  eq,
  inArray,
  isNull,
  isNotNull,
  exists,
  not,
  desc,
  sql,
} from "drizzle-orm";
import {
  CONVERSATION_RETENTION_DAYS,
  conversationTitle,
  conversationCandidateIds,
  conversationCourseAllowed,
  conversationMembersAllowed,
  conversationStoredScopeAllowed,
  conversationLogShouldExpire,
  conversationTitleOnCommit,
  conversationBooleanLogic,
} from "../../domain/conversation/conversation-lifecycle";
import { conversationDrizzleLogic as logic } from "../conversation-policy-sql";
import { apiConflict, apiNotFound } from "../../shared/errors";
import type { ConversationRepository } from "../contracts/conversation";
import pg from "pg";
import { chatAnswerSchema } from "@videoq/trpc/chat";
import type { RagResult } from "../../lib/rag";
import { databaseConnectionString, withDb, type Db } from "../../db/pool";
import {
  chatConversations as conversations,
  chatConversationTurns as turns,
  ltiConversationScopes as scopes,
  videoCourses,
  videoCourseMembers,
  videos,
  chatLogs,
  ltiChatLogSubjects as subjects,
} from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import { checkedLtiSubject } from "../../features/lti/identity";
import { lockLtiDataSessionWithDb } from "./lti-session-lock";
import { conversationThreadId } from "../../shared/conversation-scope";
import {
  CONVERSATION_CHECKPOINT_SCHEMA,
  ConversationNotFoundError,
  ConversationBusyError,
  type ConversationScope,
  type PersistConversationLog,
  type PersistedConversationAnswer,
} from "../contracts/conversation";
import { createChatLogWithDb } from "./chat-repository";
const retention = (clock: "now" | "fresh") =>
  clock === "now"
    ? sql`now()+(${CONVERSATION_RETENTION_DAYS}*interval '1 day')`
    : sql`clock_timestamp()+(${CONVERSATION_RETENTION_DAYS}*interval '1 day')`;
/** Course and member locks keep current backend membership stable throughout the operation. */
export async function lockLtiConversationCourse(
  db: Db,
  scope: ConversationScope,
  allowEmpty = false,
) {
  if (!scope.ltiSubject) return;
  const subject = checkedLtiSubject(scope.ltiSubject);
  await lockLtiDataSessionWithDb(db, scope.ownerUserId, subject.sessionProof);
  const [course] = await db
    .select({ owner: videoCourses.userId })
    .from(videoCourses)
    .where(eq(videoCourses.id, sql`${scope.courseId}`))
    .for("share");
  if (
    !conversationCourseAllowed(
      subject.resourceVideoIds.length,
      course?.owner === scope.ownerUserId,
      allowEmpty,
      conversationBooleanLogic,
    )
  )
    throw new ConversationNotFoundError();
  const members = await db
    .select({ id: videoCourseMembers.videoId })
    .from(videoCourseMembers)
    .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
    .where(
      and(
        eq(videoCourseMembers.courseId, sql`${scope.courseId}`),
        eq(videos.userId, scope.ownerUserId),
        inArray(videoCourseMembers.videoId, subject.resourceVideoIds),
      ),
    )
    .for("share", { of: [videoCourseMembers, videos] });
  if (
    !conversationMembersAllowed(
      members.length,
      subject.resourceVideoIds.length,
      conversationBooleanLogic,
    )
  )
    throw new ConversationNotFoundError();
}
export async function withConversationRead<T>(
  env: Bindings,
  scope: ConversationScope,
  operation: (db: Db) => Promise<T>,
): Promise<T> {
  return withDb(env, (db) =>
    scope.ltiSubject
      ? db.transaction(async (tx) => {
          await lockLtiConversationCourse(tx, scope, true);
          return operation(tx);
        })
      : operation(db),
  );
}
export function ltiConversationFilter(scope: ConversationScope) {
  if (!scope.ltiSubject) return sql`true`;
  const subject = checkedLtiSubject(scope.ltiSubject);
  // The subject and whole original resource set must still belong to this scope.
  return exists(
    new QueryBuilder()
      .select({ id: scopes.threadId })
      .from(scopes)
      .where(
        and(
          eq(scopes.threadId, conversations.threadId),
          conversationStoredScopeAllowed(
            eq(scopes.subjectKey, subject.subjectKey),
            sql`${scopes.resourceVideoIds}<@${JSON.stringify(subject.resourceVideoIds)}::jsonb`,
            logic,
          ),
        ),
      ),
  );
}
/** Authorization precedes opening; callers cannot supply an unscoped thread ID. */
export async function openConversation(
  env: Bindings,
  scope: ConversationScope,
  conversationId: string,
  requireExisting = false,
) {
  const { PostgresSaver } =
    await import("@langchain/langgraph-checkpoint-postgres");
  const threadId = await conversationThreadId(scope, conversationId),
    leaseId = crypto.randomUUID(),
    scopeKey = await conversationThreadId(scope, "scope");
  const checkpointId = await withDb(env, (database) =>
    database.transaction(async (db) => {
      await lockLtiConversationCourse(db, scope);
      if (
        requireExisting &&
        !(
          await db
            .select({ id: conversations.threadId })
            .from(conversations)
            .where(
              and(
                eq(conversations.threadId, threadId),
                sql`${conversations.expiresAt}>now()`,
              ),
            )
            .for("update")
        ).length
      )
        throw new ConversationNotFoundError();
      await db
        .delete(conversations)
        .where(
          and(
            eq(conversations.threadId, threadId),
            sql`${conversations.expiresAt}<now()`,
          ),
        );
      const opened = await db
        .insert(conversations)
        .values({
          threadId,
          ownerUserId: scope.ownerUserId,
          actorUserId: scope.actorUserId,
          courseId: scope.courseId,
          leaseId,
          conversationId,
          scopeKey,
          leasedUntil: sql`now()+interval '20 minutes'`,
          expiresAt: retention("now"),
        })
        .onConflictDoUpdate({
          target: conversations.threadId,
          set: {
            leaseId,
            leasedUntil: sql`excluded.leased_until`,
            expiresAt: sql`excluded.expires_at`,
            conversationId,
            scopeKey,
          },
          setWhere: or(
            isNull(conversations.leaseId),
            sql`${conversations.leasedUntil}<now()`,
          ),
        })
        .returning({ id: conversations.threadId });
      if (!opened.length) throw new ConversationBusyError();
      if (scope.ltiSubject) {
        const subject = checkedLtiSubject(scope.ltiSubject);
        const [previous] = await db
          .select({
            allowed: conversationStoredScopeAllowed(
              eq(scopes.subjectKey, subject.subjectKey),
              sql`${scopes.resourceVideoIds}<@${JSON.stringify(subject.resourceVideoIds)}::jsonb`,
              logic,
            ),
          })
          .from(scopes)
          .where(eq(scopes.threadId, threadId));
        if (previous && !previous.allowed)
          throw new ConversationNotFoundError();
        await db
          .insert(scopes)
          .values({
            threadId,
            subjectKey: subject.subjectKey,
            resourceVideoIds: subject.resourceVideoIds,
          })
          .onConflictDoNothing({ target: scopes.threadId });
      }
      const [row] = await db
        .select({ id: conversations.committedCheckpointId })
        .from(conversations)
        .where(
          and(
            eq(conversations.threadId, threadId),
            eq(conversations.leaseId, leaseId),
          ),
        );
      return row.id;
    }),
  );
  // Workers cannot share pools across requests; Node can reuse its configured pool.
  const pool =
    env.DATABASE_POOL ??
    new pg.Pool({
      connectionString: databaseConnectionString(env),
      max: 2,
      connectionTimeoutMillis: 10_000,
    });
  return {
    threadId,
    checkpointId,
    saver: new PostgresSaver(pool, undefined, {
      schema: CONVERSATION_CHECKPOINT_SCHEMA,
    }),
    async commit(
      result: RagResult,
      persistLog?: PersistConversationLog,
    ): Promise<PersistedConversationAnswer> {
      if (!result.checkpointId)
        throw new Error("Missing conversation checkpoint");
      return withDb(env, (database) =>
        database.transaction(async (db) => {
          await lockLtiConversationCourse(db, scope);
          const owned = await db
            .select({ id: conversations.threadId })
            .from(conversations)
            .where(
              and(
                eq(conversations.threadId, threadId),
                eq(conversations.leaseId, leaseId),
                sql`${conversations.leasedUntil}>now()`,
              ),
            )
            .for("update");
          if (!owned.length) throw new ConversationBusyError();
          const input = persistLog ? await persistLog(result) : null,
            log = input ? await createChatLogWithDb(db, input) : null;
          const persisted = log
            ? { chatLogId: log.id, feedback: log.feedback }
            : { chatLogId: null, feedback: null };
          if (scope.ltiSubject)
            await db
              .update(scopes)
              .set({
                resourceVideoIds: checkedLtiSubject(scope.ltiSubject)
                  .resourceVideoIds,
              })
              .where(eq(scopes.threadId, threadId));
          await db
            .insert(turns)
            .values({
              threadId,
              checkpointId: result.checkpointId!,
              question: result.queryText,
              response: chatAnswerSchema.parse(result.answer),
              chatLogId: persisted.chatLogId,
            });
          await db
            .update(conversations)
            .set({
              committedCheckpointId: result.checkpointId,
              title: sql`${conversationTitleOnCommit(conversations.title, sql`${conversationTitle(result.queryText)}`, logic)}`,
              updatedAt: sql`clock_timestamp()`,
              expiresAt: retention("fresh"),
            })
            .where(
              and(
                eq(conversations.threadId, threadId),
                eq(conversations.leaseId, leaseId),
              ),
            );
          return persisted;
        }),
      );
    },
    async close() {
      try {
        await withDb(env, (db) =>
          db
            .update(conversations)
            .set({ leaseId: null, leasedUntil: null })
            .where(
              and(
                eq(conversations.threadId, threadId),
                eq(conversations.leaseId, leaseId),
              ),
            ),
        );
      } finally {
        if (!env.DATABASE_POOL) await pool.end();
      }
    },
  };
}
/** Lock expired threads before cleanup, serializing against resumes and commits. */
export async function pruneConversations(env: Bindings): Promise<number> {
  return withDb(env, (database) =>
    database.transaction(async (db) => {
      await db
        .select({ id: conversations.threadId })
        .from(conversations)
        .where(sql`${conversations.expiresAt}<now()`)
        .for("update");
      const linked = (expired: boolean) =>
        exists(
          db
            .select({ id: turns.id })
            .from(turns)
            .innerJoin(
              conversations,
              eq(conversations.threadId, turns.threadId),
            )
            .where(
              and(
                eq(turns.chatLogId, chatLogs.id),
                expired
                  ? sql`${conversations.expiresAt}<now()`
                  : sql`${conversations.expiresAt}>=now()`,
              ),
            ),
        );
      await db
        .delete(chatLogs)
        .where(
          and(
            exists(
              db
                .select({ id: subjects.chatLogId })
                .from(subjects)
                .where(eq(subjects.chatLogId, chatLogs.id)),
            ),
            conversationLogShouldExpire(
              linked(true),
              sql`${chatLogs.createdAt}<now()-(${CONVERSATION_RETENTION_DAYS}*interval '1 day')`,
              not(linked(false)),
              logic,
            ),
          ),
        );
      const deleted = await db
        .delete(conversations)
        .where(sql`${conversations.expiresAt}<now()`)
        .returning({ id: conversations.threadId });
      return deleted.length;
    }),
  );
}
const summaryProjection = {
  id: conversations.conversationId,
  title: conversations.title,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
  isGenerating: sql<boolean>`${conversations.leaseId} IS NOT NULL AND ${conversations.leasedUntil}>now()`,
};
type ConversationRow = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  isGenerating: boolean;
};
const summary = (row: ConversationRow) => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
async function listConversations(
  env: Bindings,
  scope: ConversationScope,
  input: { conversationIds?: string[]; limit: number; offset: number },
) {
  const scopeKey = await conversationThreadId(scope, "scope"),
    ids = conversationCandidateIds(scope.shareSlug, input.conversationIds);
  return withConversationRead(env, scope, async (db) => {
    const rows = await db
      .select(summaryProjection)
      .from(conversations)
      .where(
        and(
          eq(conversations.scopeKey, scopeKey),
          sql`${conversations.expiresAt}>now()`,
          isNotNull(conversations.committedCheckpointId),
          ids === null ? undefined : inArray(conversations.conversationId, ids),
          ltiConversationFilter(scope),
        ),
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.threadId))
      .limit(input.limit + 1)
      .offset(input.offset);
    return {
      items: rows.slice(0, input.limit).map(summary),
      hasMore: rows.length > input.limit,
    };
  });
}
async function getConversation(
  env: Bindings,
  scope: ConversationScope,
  input: { conversationId: string; beforeTurnId?: string; limit: number },
) {
  const threadId = await conversationThreadId(scope, input.conversationId);
  return withConversationRead(env, scope, async (db) => {
    const query = db
      .select(summaryProjection)
      .from(conversations)
      .where(
        and(
          eq(conversations.threadId, threadId),
          sql`${conversations.expiresAt}>now()`,
          ltiConversationFilter(scope),
        ),
      );
    const [row] = await (scope.ltiSubject ? query.for("share") : query);
    if (!row) throw apiNotFound("Conversation not found.");
    const page = await db
      .select({
        id: sql<string>`${turns.id}::text`,
        question: turns.question,
        response: turns.response,
        createdAt: turns.createdAt,
        chatLogId: turns.chatLogId,
        feedback: chatLogs.feedback,
      })
      .from(turns)
      .leftJoin(chatLogs, eq(chatLogs.id, turns.chatLogId))
      .where(
        and(
          eq(turns.threadId, threadId),
          input.beforeTurnId === undefined
            ? undefined
            : sql`${turns.id}<${input.beforeTurnId}::bigint`,
        ),
      )
      .orderBy(desc(turns.id))
      .limit(input.limit + 1);
    const items = page
      .slice(0, input.limit)
      .reverse()
      .map((turn) => ({
        id: turn.id,
        question: turn.question,
        answer: chatAnswerSchema.parse(turn.response),
        createdAt: turn.createdAt.toISOString(),
        chatLogId: turn.chatLogId === null ? null : Number(turn.chatLogId),
        feedback: turn.feedback as "good" | "bad" | null,
      }));
    return {
      ...summary(row),
      turns: items,
      hasMore: page.length > input.limit,
    };
  });
}
async function deleteConversation(
  env: Bindings,
  scope: ConversationScope,
  id: string,
) {
  const threadId = await conversationThreadId(scope, id);
  return withDb(env, (database) =>
    database.transaction(async (db) => {
      await lockLtiConversationCourse(db, scope, true);
      const [row] = await db
        .select({
          busy: sql<boolean>`${conversations.leaseId} IS NOT NULL AND ${conversations.leasedUntil}>now()`,
        })
        .from(conversations)
        .where(eq(conversations.threadId, threadId))
        .for("update");
      if (row?.busy)
        throw apiConflict(
          "Wait for the current answer to finish before deleting this conversation.",
          "CONVERSATION_BUSY",
        );
      await db
        .delete(chatLogs)
        .where(
          inArray(
            chatLogs.id,
            db
              .select({ id: turns.chatLogId })
              .from(turns)
              .where(eq(turns.threadId, threadId)),
          ),
        );
      await db
        .delete(conversations)
        .where(eq(conversations.threadId, threadId));
      return { success: true as const };
    }),
  );
}
export function createPostgresConversationRepository(
  env: Bindings,
): ConversationRepository {
  return {
    list: (scope, input) => listConversations(env, scope, input),
    detail: (scope, input) => getConversation(env, scope, input),
    delete: (scope, id) => deleteConversation(env, scope, id),
  };
}
