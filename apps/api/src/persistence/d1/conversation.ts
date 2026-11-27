import {
  and,
  or,
  eq,
  ne,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  exists,
  notExists,
  not,
  desc,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/sqlite-core";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectValues,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  mutationReceipts as receipts,
  chatConversations as conversations,
  ltiConversationScopes as scopes,
  users,
  ltiCredentials,
  videoCourses,
  videoCourseMembers,
  videos,
  conversationCheckpoints as checkpoints,
  chatConversationTurns as turns,
  chatLogs,
  ltiChatLogSubjects as subjects,
} from "../../db/schema/sqlite";
import {
  CONVERSATION_RETENTION_DAYS,
  conversationTitle,
  conversationCandidateIds,
  conversationCourseAllowed,
  conversationMembersAllowed,
  conversationStoredScopeAllowed,
  conversationLogShouldExpire,
  conversationTitleOnCommit,
  conversationStoredScopeConflict,
} from "../../domain/conversation/conversation-lifecycle";
import { conversationDrizzleLogic as logic } from "../conversation-policy-sql";
import { apiConflict, apiNotFound, ApiError } from "../../shared/errors";
import type {
  ConversationRepository,
  ConversationSummary,
  ConversationTurn,
} from "../contracts/conversation";
import { toUtcIso } from "../../shared/datetime";
import { chatAnswerSchema } from "@videoq/trpc/chat";
import { checkedLtiSubject } from "../../features/lti/identity";
import { conversationThreadId } from "../../shared/conversation-scope";
import {
  ConversationBusyError,
  ConversationNotFoundError,
  type ConversationScope,
  type OpenConversation,
} from "../contracts/conversation";
import { D1CheckpointSaver } from "./checkpoint-saver";
import { d1ChatLogStatements } from "./chat-repository";
const qb = new QueryBuilder();
const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const retention = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now',${"+" + CONVERSATION_RETENTION_DAYS + " days"})`;
const gate = (token: string) =>
  exists(
    qb
      .select({ token: receipts.token })
      .from(receipts)
      .where(eq(receipts.token, token)),
  );
function sessionGuard(scope: ConversationScope) {
  const proof = scope.ltiSubject
    ? checkedLtiSubject(scope.ltiSubject).sessionProof
    : undefined;
  const c = alias(ltiCredentials, "conversation_session");
  return proof
    ? exists(
        qb
          .select({ id: users.id })
          .from(users)
          .innerJoin(c, eq(c.id, proof.sessionHash))
          .where(
            and(
              eq(users.id, scope.ownerUserId),
              eq(c.kind, "session"),
              sql`julianday(${c.expiresAt})>julianday('now')`,
              eq(
                sql`json_extract(${c.payload},'$.registrationId')`,
                proof.registrationId,
              ),
              eq(
                sql`json_extract(${c.payload},'$.subjectHash')`,
                proof.subjectHash,
              ),
            ),
          ),
      )
    : sql`1`;
}
function scopeFailure(sessionAllowed: unknown): never {
  if (!sessionAllowed)
    throw new ApiError(403, "FORBIDDEN", "The Moodle session is unavailable.");
  throw new ConversationNotFoundError();
}
function contained(ids: number[]) {
  return notExists(
    qb
      .select({ value: sql`previous.value` })
      .from(sql`json_each(${scopes.resourceVideoIds}) previous`)
      .where(
        notInArray(
          sql`previous.value`,
          qb
            .select({ value: sql`value` })
            .from(sql`json_each(${JSON.stringify(ids)})`),
        ),
      ),
  );
}
function scopeGuard(
  scope: ConversationScope,
  threadId: string,
  allowEmpty = false,
  ignoreStored = false,
) {
  if (!scope.ltiSubject) return sql`1`;
  const subject = checkedLtiSubject(scope.ltiSubject),
    live = alias(conversations, "live");
  const count = qb
    .select({ count: sql<number>`count(*)` })
    .from(videoCourseMembers)
    .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
    .where(
      and(
        eq(videoCourseMembers.courseId, sql`${scope.courseId}`),
        eq(videos.userId, scope.ownerUserId),
        inArray(videoCourseMembers.videoId, subject.resourceVideoIds),
      ),
    );
  return and(
    conversationCourseAllowed(
      sql`${subject.resourceVideoIds.length}`,
      exists(
        qb
          .select({ id: videoCourses.id })
          .from(videoCourses)
          .where(
            and(
              eq(videoCourses.id, sql`${scope.courseId}`),
              eq(videoCourses.userId, scope.ownerUserId),
            ),
          ),
      ),
      allowEmpty,
      logic,
    ),
    conversationMembersAllowed(
      sql`${count}`,
      sql`${subject.resourceVideoIds.length}`,
      logic,
    ),
    ignoreStored
      ? undefined
      : notExists(
          qb
            .select({ id: scopes.threadId })
            .from(scopes)
            .where(
              and(
                eq(scopes.threadId, threadId),
                exists(
                  qb
                    .select({ id: live.threadId })
                    .from(live)
                    .where(
                      and(
                        eq(live.threadId, scopes.threadId),
                        sql`julianday(${live.expiresAt})>=julianday('now')`,
                      ),
                    ),
                ),
                conversationStoredScopeConflict(
                  ne(scopes.subjectKey, subject.subjectKey),
                  not(contained(subject.resourceVideoIds)),
                  logic,
                ),
              ),
            ),
        ),
    sessionGuard(scope),
  )!;
}
// Keep the receipt's creation and all guarded effects in a single D1 batch.
function receiptInsert(
  db: ReturnType<typeof createD1Connection>,
  token: string,
  kind: string,
  condition: SQL,
) {
  return db.insert(receipts).select(
    db
      .select(insertSelectValues(receipts, { token, kind, resourceId: 0 }))
      .from(sql`(VALUES(1)) input`)
      .where(condition),
  );
}
function visibleScope(scope: ConversationScope) {
  if (!scope.ltiSubject) return sql`1`;
  const subject = checkedLtiSubject(scope.ltiSubject);
  return exists(
    qb
      .select({ id: scopes.threadId })
      .from(scopes)
      .where(
        and(
          eq(scopes.threadId, conversations.threadId),
          conversationStoredScopeAllowed(
            eq(scopes.subjectKey, subject.subjectKey),
            contained(subject.resourceVideoIds),
            logic,
          ),
        ),
      ),
  );
}
const generating = and(
  isNotNull(conversations.leaseId),
  sql`julianday(${conversations.leasedUntil})>julianday('now')`,
)!;
const idle = or(
  isNull(conversations.leaseId),
  sql`julianday(${conversations.leasedUntil})<=julianday('now')`,
)!;
const summaryProjection = {
  id: conversations.conversationId,
  title: conversations.title,
  createdAt: sql<string>`${conversations.createdAt}`,
  updatedAt: sql<string>`${conversations.updatedAt}`,
  isGenerating: generating,
};
const summary = (row: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  isGenerating: unknown;
}): ConversationSummary => ({
  ...row,
  createdAt: toUtcIso(row.createdAt),
  updatedAt: toUtcIso(row.updatedAt),
  isGenerating: Boolean(row.isGenerating),
});
export async function openD1Conversation(
  database: D1Database,
  scope: ConversationScope,
  conversationId: string,
  requireExisting = false,
): Promise<OpenConversation<D1CheckpointSaver>> {
  const db = createD1Connection(database),
    threadId = await conversationThreadId(scope, conversationId),
    scopeKey = await conversationThreadId(scope, "scope");
  const leaseId = crypto.randomUUID(),
    token = crypto.randomUUID(),
    session = sessionGuard(scope);
  const statements: D1Query[] = [
    receiptInsert(
      db,
      token,
      "conversation_open",
      and(
        scopeGuard(scope, threadId),
        requireExisting
          ? exists(
              db
                .select({ id: conversations.threadId })
                .from(conversations)
                .where(
                  and(
                    eq(conversations.threadId, threadId),
                    sql`julianday(${conversations.expiresAt})>julianday('now')`,
                  ),
                ),
            )
          : undefined,
      )!,
    ),
    db
      .delete(conversations)
      .where(
        and(
          eq(conversations.threadId, threadId),
          sql`julianday(${conversations.expiresAt})<julianday('now')`,
          gate(token),
        ),
      ),
    db
      .insert(conversations)
      .select(
        db
          .select(
            insertSelectValues(conversations, {
              threadId,
              ownerUserId: scope.ownerUserId,
              actorUserId: scope.actorUserId,
              courseId: scope.courseId,
              leaseId,
              conversationId,
              scopeKey,
              leasedUntil: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now','+20 minutes')`,
              expiresAt: retention,
            }),
          )
          .from(receipts)
          .where(eq(receipts.token, token)),
      )
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
          sql`julianday(${conversations.leasedUntil})<julianday('now')`,
        ),
      }),
    receiptInsert(db, token + ":lease", "conversation_lease", sql`changes()=1`),
  ];
  if (scope.ltiSubject) {
    const subject = checkedLtiSubject(scope.ltiSubject);
    statements.push(
      db
        .insert(scopes)
        .select(
          db
            .select(
              insertSelectValues(scopes, {
                threadId,
                subjectKey: subject.subjectKey,
                resourceVideoIds: subject.resourceVideoIds,
              }),
            )
            .from(receipts)
            .where(eq(receipts.token, token + ":lease")),
        )
        .onConflictDoNothing({ target: scopes.threadId }),
    );
  }
  statements.push(
    db
      .select({
        checkpoint: sql<
          string | null
        >`${conversations.committedCheckpointId}`.as("checkpoint"),
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.threadId, threadId),
          eq(conversations.leaseId, leaseId),
          gate(token + ":lease"),
        ),
      ),
    db
      .select({
        session: session.as("session"),
        eligible: gate(token).as("eligible"),
      })
      .from(sql`(VALUES(1)) input`),
    db
      .delete(receipts)
      .where(inArray(receipts.token, [token, token + ":lease"])),
  );
  const opened = await runD1Batch<{
      checkpoint: string | null;
      session: number;
      eligible: number;
    }>(database, statements),
    row = opened[opened.length - 3].results[0];
  if (!row) {
    const access = opened[opened.length - 2].results[0];
    if (!access.session) scopeFailure(0);
    if (access.eligible) throw new ConversationBusyError();
    throw new ConversationNotFoundError();
  }
  return {
    threadId,
    checkpointId: row.checkpoint,
    saver: new D1CheckpointSaver(database, { threadId, leaseId }),
    async commit(result, prepareLog) {
      if (!result.checkpointId)
        throw new Error("Missing conversation checkpoint");
      const logInput = prepareLog ? await prepareLog(result) : null,
        answer = chatAnswerSchema.parse(result.answer),
        commitToken = crypto.randomUUID(),
        logToken = commitToken + ":log";
      const finalGate = and(
        gate(commitToken),
        logInput ? gate(logToken) : undefined,
      )!;
      const batch: (D1Query | D1PreparedStatement)[] = [
        receiptInsert(
          db,
          commitToken + ":scope",
          "conversation_scope",
          scopeGuard(scope, threadId),
        ),
        receiptInsert(
          db,
          commitToken,
          "conversation_commit",
          and(
            gate(commitToken + ":scope"),
            exists(
              db
                .select({ id: conversations.threadId })
                .from(conversations)
                .where(
                  and(
                    eq(conversations.threadId, threadId),
                    eq(conversations.leaseId, leaseId),
                    sql`julianday(${conversations.leasedUntil})>julianday('now')`,
                  ),
                ),
            ),
            exists(
              db
                .select({ id: checkpoints.checkpointId })
                .from(checkpoints)
                .where(
                  and(
                    eq(checkpoints.threadId, threadId),
                    eq(checkpoints.namespace, ""),
                    eq(checkpoints.checkpointId, result.checkpointId),
                  ),
                ),
            ),
          )!,
        ),
      ];
      if (logInput)
        batch.push(
          ...d1ChatLogStatements(
            database,
            logInput,
            logToken,
            gate(commitToken),
          ),
        );
      if (scope.ltiSubject)
        batch.push(
          db
            .update(scopes)
            .set({
              resourceVideoIds: checkedLtiSubject(scope.ltiSubject)
                .resourceVideoIds,
            })
            .where(and(eq(scopes.threadId, threadId), finalGate)),
        );
      const logId = db
        .select({ id: receipts.resourceId })
        .from(receipts)
        .where(eq(receipts.token, logToken));
      batch.push(
        db.insert(turns).select(
          db
            .select(
              insertSelectValues(turns, {
                threadId,
                checkpointId: result.checkpointId,
                question: result.queryText,
                response: answer,
                chatLogId: sql`${logId}`,
              }),
            )
            .from(receipts)
            .where(
              and(
                eq(receipts.token, commitToken),
                logInput ? gate(logToken) : undefined,
              ),
            ),
        ),
        db
          .update(conversations)
          .set({
            committedCheckpointId: result.checkpointId,
            title: sql`${conversationTitleOnCommit(conversations.title, sql`${conversationTitle(result.queryText)}`, logic)}`,
            updatedAt: now,
            expiresAt: retention,
          })
          .where(
            and(
              eq(conversations.threadId, threadId),
              eq(conversations.leaseId, leaseId),
              finalGate,
            ),
          ),
        db
          .select({ chatLogId: sql<number | null>`${logId}`.as("chatLogId") })
          .from(receipts)
          .where(
            and(
              eq(receipts.token, commitToken),
              logInput ? gate(logToken) : undefined,
            ),
          ),
        db
          .select({
            session: session.as("session"),
            allowed: gate(commitToken + ":scope").as("allowed"),
          })
          .from(sql`(VALUES(1)) input`),
        db
          .delete(receipts)
          .where(
            inArray(receipts.token, [
              commitToken,
              logToken,
              commitToken + ":scope",
            ]),
          ),
      );
      const committed = await runD1Batch<{
          chatLogId: number | null;
          session: number;
          allowed: number;
        }>(database, batch),
        saved = committed[committed.length - 3].results[0],
        access = committed[committed.length - 2].results[0];
      if (!access.allowed) scopeFailure(access.session);
      if (!saved) throw new ConversationBusyError();
      return { chatLogId: saved.chatLogId, feedback: null };
    },
    async close() {
      await db
        .update(conversations)
        .set({ leaseId: null, leasedUntil: null })
        .where(
          and(
            eq(conversations.threadId, threadId),
            eq(conversations.leaseId, leaseId),
          ),
        );
    },
  };
}
export async function pruneD1Conversations(
  database: D1Database,
): Promise<number> {
  const db = createD1Connection(database);
  const linked = (expired: boolean) =>
    exists(
      db
        .select({ id: turns.id })
        .from(turns)
        .innerJoin(conversations, eq(conversations.threadId, turns.threadId))
        .where(
          and(
            eq(turns.chatLogId, chatLogs.id),
            expired
              ? sql`julianday(${conversations.expiresAt})<julianday('now')`
              : sql`julianday(${conversations.expiresAt})>=julianday('now')`,
          ),
        ),
    );
  const result = await db.batch([
    db
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
            sql`julianday(${chatLogs.createdAt})<julianday('now',${"-" + CONVERSATION_RETENTION_DAYS + " days"})`,
            not(linked(false)),
            logic,
          ),
        ),
      ),
    db
      .delete(conversations)
      .where(sql`julianday(${conversations.expiresAt})<julianday('now')`)
      .returning({ id: conversations.threadId }),
  ]);
  return result[1].length;
}
export function createD1ConversationRepository(
  database: D1Database,
): ConversationRepository {
  const db = createD1Connection(database);
  const access = (scope: ConversationScope, condition: SQL) =>
    db
      .select({
        allowed: condition.as("allowed"),
        session: sessionGuard(scope).as("session"),
      })
      .from(sql`(VALUES(1)) input`);
  return {
    async list(scope, input) {
      const scopeKey = await conversationThreadId(scope, "scope"),
        guard = scopeGuard(scope, "", true, true),
        candidates = conversationCandidateIds(
          scope.shareSlug,
          input.conversationIds,
        );
      const result = await db.batch([
        access(scope, guard),
        db
          .select(summaryProjection)
          .from(conversations)
          .where(
            and(
              eq(conversations.scopeKey, scopeKey),
              sql`julianday(${conversations.expiresAt})>julianday('now')`,
              isNotNull(conversations.committedCheckpointId),
              candidates === null
                ? undefined
                : inArray(conversations.conversationId, candidates),
              guard,
              visibleScope(scope),
            ),
          )
          .orderBy(desc(conversations.updatedAt), desc(conversations.threadId))
          .limit(input.limit + 1)
          .offset(input.offset),
      ]);
      if (!result[0][0]?.allowed) scopeFailure(result[0][0]?.session);
      return {
        items: result[1].slice(0, input.limit).map(summary),
        hasMore: result[1].length > input.limit,
      };
    },
    async detail(scope, input) {
      const threadId = await conversationThreadId(scope, input.conversationId),
        permission = and(
          eq(conversations.threadId, threadId),
          sql`julianday(${conversations.expiresAt})>julianday('now')`,
          scopeGuard(scope, threadId, true),
          visibleScope(scope),
        );
      const result = await db.batch([
        access(scope, scopeGuard(scope, threadId, true, true)),
        db.select(summaryProjection).from(conversations).where(permission),
        db
          .select({
            id: sql<string>`CAST(${turns.id} AS TEXT)`,
            question: turns.question,
            response: turns.response,
            createdAt: sql<string>`${turns.createdAt}`,
            chatLogId: turns.chatLogId,
            feedback: chatLogs.feedback,
          })
          .from(turns)
          .leftJoin(chatLogs, eq(chatLogs.id, turns.chatLogId))
          .where(
            and(
              eq(turns.threadId, threadId),
              input.beforeTurnId == null
                ? undefined
                : sql`${turns.id}<CAST(${input.beforeTurnId} AS INTEGER)`,
              exists(
                db
                  .select({ id: conversations.threadId })
                  .from(conversations)
                  .where(permission),
              ),
            ),
          )
          .orderBy(desc(turns.id))
          .limit(input.limit + 1),
      ]);
      if (!result[0][0]?.allowed) scopeFailure(result[0][0]?.session);
      const row = result[1][0];
      if (!row) throw apiNotFound("Conversation not found.");
      const page: ConversationTurn[] = result[2]
        .slice(0, input.limit)
        .reverse()
        .map((t) => ({
          id: t.id,
          question: t.question,
          answer: chatAnswerSchema.parse(t.response),
          createdAt: toUtcIso(t.createdAt),
          chatLogId: t.chatLogId,
          feedback: t.feedback as "good" | "bad" | null,
        }));
      return {
        ...summary(row),
        turns: page,
        hasMore: result[2].length > input.limit,
      };
    },
    async delete(scope, id) {
      const threadId = await conversationThreadId(scope, id),
        token = crypto.randomUUID();
      const result = await db.batch([
        receiptInsert(
          db,
          token,
          "conversation_delete",
          scopeGuard(scope, threadId, true, true),
        ),
        db
          .select({ busy: generating })
          .from(conversations)
          .where(and(eq(conversations.threadId, threadId), gate(token))),
        db.delete(chatLogs).where(
          and(
            inArray(
              chatLogs.id,
              db
                .select({ id: turns.chatLogId })
                .from(turns)
                .innerJoin(
                  conversations,
                  eq(conversations.threadId, turns.threadId),
                )
                .where(and(eq(conversations.threadId, threadId), idle)),
            ),
            gate(token),
          ),
        ),
        db
          .delete(conversations)
          .where(and(eq(conversations.threadId, threadId), idle, gate(token))),
        db
          .select({ session: sessionGuard(scope), eligible: gate(token) })
          .from(sql`(VALUES(1)) input`),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      if (!result[4][0]?.eligible) scopeFailure(result[4][0]?.session);
      if (result[1][0]?.busy)
        throw apiConflict(
          "Wait for the current answer to finish before deleting this conversation.",
          "CONVERSATION_BUSY",
        );
      return { success: true };
    },
  };
}
