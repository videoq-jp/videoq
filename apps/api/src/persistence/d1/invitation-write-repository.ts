import {
  invitationDecisionState,
  invitationRecipientState,
  invitationControlState,
  invitationDecisionEffects,
  invitationControlEffects,
} from "../../domain/learning/invitation-lifecycle";
import { nativeCourseExternalAllowed } from "../../domain/learning/native-course-access";
import { nativeCourseDrizzleLogic } from "../native-course-policy-sql";
import {
  sql,
  and,
  or,
  eq,
  ne,
  exists,
  notExists,
  isNull,
  inArray,
  type SQL,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  users,
  videos,
  videoCourses,
  videoCourseMembers,
  videoCourseInvitations as invitations,
  videoCourseMemberships as memberships,
  videoCourseMemberships,
  mutationReceipts as receipts,
  externalTasks,
} from "../../db/schema/sqlite";
import { normalizeInvitationEmail } from "@videoq/domain/course-invitations";
import type { InvitationStatus } from "../../domain/learning/course-invitations";
import type {
  InvitationDecisionResult,
  InvitationControlResult,
  InvitationWriteRepository,
} from "../contracts/invitation-write-repository";

type Database = ReturnType<typeof createD1Connection>;
type Statement = { toSQL(): { sql: string; params: unknown[] } };
const invitationSqlChoice = {
  and: (left: SQL, right: SQL) => and(left, right)!,
  when: (condition: SQL, yes: SQL, no: SQL) =>
    sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};

function nativeCourse(db: Database): SQL {
  return nativeCourseExternalAllowed(
    {
      independentlyManaged: eq(videoCourses.managedByLms, false),
      nativeAccessEnabled: eq(videoCourses.nativeAccessDisabled, false),
      noLmsVideo: notExists(
        db
          .select({ id: videoCourseMembers.videoId })
          .from(videoCourseMembers)
          .innerJoin(videos, eq(videos.id, videoCourseMembers.videoId))
          .where(
            and(
              eq(videoCourseMembers.courseId, videoCourses.id),
              eq(videos.managedByLms, true),
            ),
          ),
      ),
    },
    nativeCourseDrizzleLogic,
  );
}

function receiptFilter(token: string, kinds: string[]) {
  return and(eq(receipts.token, token), inArray(receipts.kind, kinds))!;
}

function targetInvitations(db: Database, token: string, kind: string) {
  return inArray(
    invitations.id,
    db
      .select({ id: receipts.resourceId })
      .from(receipts)
      .where(receiptFilter(token, [kind])),
  );
}

function expiredAt(at: string) {
  // julianday preserves instant comparisons for equivalent timestamp formats.
  return sql`julianday(${invitations.expiresAt})<=julianday(${at})`;
}

function buildDecisionStatements(
  db: Database,
  action: "accept" | "decline",
  hash: string,
  userId: string,
  at: string,
  token: string,
  user: { email: string; emailVerified: boolean } | undefined,
): Statement[] {
  const effects = invitationDecisionEffects(action);
  const normalizedEmail = user ? normalizeInvitationEmail(user.email) : null;
  const recipient = invitationRecipientState(
    {
      unverified: or(isNull(users.id), ne(users.emailVerified, true))!,
      // SQLite IS NOT is null-safe; it detects deletion or changes to the snapshot.
      identityChanged: sql`${users.email} IS NOT ${user?.email ?? null} OR ${users.emailVerified} IS NOT ${user ? Number(user.emailVerified) : null}`,
      emailMismatch: sql`${normalizedEmail} IS NULL OR ${normalizedEmail}<>${invitations.email}`,
    },
    {
      unverified: sql`'unverified'`,
      retry: sql`'retry'`,
      mismatch: sql`'mismatch'`,
      apply: sql`'apply'`,
    },
    invitationSqlChoice,
  );
  const state = invitationDecisionState(
    {
      accepting: sql`${Number(effects.addMembership)}`,
      accepted: eq(invitations.status, "accepted"),
      acceptedByActor: eq(invitations.acceptedByUserId, userId),
      notPending: ne(invitations.status, "pending"),
      expired: expiredAt(at),
    },
    {
      replay: sql`'replay'`,
      invalidState: sql`'state:'||${invitations.status}`,
      expired: sql`'expired'`,
      recipient,
    },
    invitationSqlChoice,
  );
  const statements: Statement[] = [
    db.insert(receipts).select(
      db
        .select({
          token: sql<string>`${token}`.as("token"),
          kind: sql<string>`'invitation_decision:'||${state}`.as("kind"),
          resourceId: invitations.id,
          effectApplied: sql<boolean>`0`.as("effectApplied"),
        })
        .from(invitations)
        .innerJoin(videoCourses, eq(videoCourses.id, invitations.courseId))
        .leftJoin(users, eq(users.id, userId))
        .where(
          and(
            eq(invitations.tokenHash, hash),
            effects.requiresNative ? nativeCourse(db) : undefined,
          ),
        ),
    ),
  ];
  if (effects.addMembership) {
    statements.push(
      db
        .insert(memberships)
        .select(
          db
            .select({
              id: sql<number>`NULL`.as("id"),
              courseId: invitations.courseId,
              userId: sql<string>`${userId}`.as("userId"),
              invitationId: invitations.id,
              joinedAt: sql<string>`${at}`.as("joinedAt"),
            })
            .from(invitations)
            .where(targetInvitations(db, token, "invitation_decision:apply")),
        )
        .onConflictDoNothing(),
    );
  }
  statements.push(
    db
      .update(invitations)
      .set({ status: "expired", updatedAt: at })
      .where(targetInvitations(db, token, "invitation_decision:expired")),
    db
      .update(invitations)
      .set({
        status: effects.status,
        updatedAt: at,
        ...(effects.addMembership
          ? { acceptedByUserId: userId, acceptedAt: at }
          : {}),
      })
      .where(targetInvitations(db, token, "invitation_decision:apply")),
    db
      .select({ kind: receipts.kind, course_id: invitations.courseId })
      .from(receipts)
      .innerJoin(invitations, eq(invitations.id, receipts.resourceId))
      .where(eq(receipts.token, token)),
    db.delete(receipts).where(eq(receipts.token, token)),
  );
  return statements;
}

function buildControlStatements(
  db: Database,
  action: "resend" | "revoke",
  courseId: number,
  invitationId: number,
  ownerId: string,
  at: string,
  token: string,
  emailDelivery: boolean,
  now: Date,
  replacement: { tokenHash: string; expiresAt: Date } | undefined,
): Statement[] {
  const effects = invitationControlEffects(action);
  const state = invitationControlState(
    { notPending: ne(invitations.status, "pending"), expired: expiredAt(at) },
    {
      invalidState: sql`'state:'||${invitations.status}`,
      expired: sql`'state:expired'`,
      apply: sql`'apply'`,
    },
    invitationSqlChoice,
  );
  const statements: Statement[] = [
    db.insert(receipts).select(
      db
        .select({
          token: sql<string>`${token}`.as("token"),
          kind: sql<string>`'invitation_control:'||${state}`.as("kind"),
          resourceId: invitations.id,
          effectApplied: sql<boolean>`0`.as("effectApplied"),
        })
        .from(invitations)
        .innerJoin(videoCourses, eq(videoCourses.id, invitations.courseId))
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.courseId, courseId),
            eq(videoCourses.userId, ownerId),
            effects.requiresNative ? nativeCourse(db) : undefined,
          ),
        ),
    ),
    db
      .update(invitations)
      .set({ status: "expired", updatedAt: at })
      .where(
        and(
          eq(invitations.status, "pending"),
          targetInvitations(db, token, "invitation_control:state:expired"),
        ),
      ),
  ];
  if (effects.rotateToken) {
    if (!replacement) throw new Error("Missing replacement token");
    statements.push(
      db
        .update(invitations)
        .set({
          tokenHash: replacement.tokenHash,
          expiresAt: replacement.expiresAt.toISOString(),
          deliveryStatus: "queued",
          lastError: null,
          updatedAt: at,
        })
        .where(
          and(
            eq(invitations.status, "pending"),
            targetInvitations(db, token, "invitation_control:apply"),
          ),
        ),
    );
    if (emailDelivery) {
      // INSERT SELECT requires all schema columns, including their defaults.
      const timestamp = sql<string>`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
      statements.push(
        db
          .insert(externalTasks)
          .select(
            db
              .select({
                id: sql<number>`NULL`.as("id"),
                kind: sql<string>`'invitation_email'`.as("kind"),
                payload: sql<
                  Record<string, unknown>
                >`${JSON.stringify({ invitation_id: invitationId })}`.as(
                  "payload",
                ),
                dedupeKey:
                  sql<string>`${`invitation_email:${invitationId}:${now.getTime()}`}`.as(
                    "dedupe_key",
                  ),
                attempts: sql<number>`0`.as("attempts"),
                availableAt: timestamp.as("available_at"),
                lockedAt: sql<string>`NULL`.as("lockedAt"),
                completedAt: sql<string>`NULL`.as("completedAt"),
                deadAt: sql<string>`NULL`.as("deadAt"),
                effectAppliedAt: sql<string>`NULL`.as("effectAppliedAt"),
                lastError: sql<string>`''`.as("lastError"),
                createdAt: timestamp.as("created_at"),
                updatedAt: timestamp.as("updated_at"),
              })
              .from(receipts)
              .where(receiptFilter(token, ["invitation_control:apply"])),
          )
          .onConflictDoNothing(),
      );
    }
  } else {
    statements.push(
      db
        .update(invitations)
        .set({ status: "revoked", updatedAt: at })
        .where(
          and(
            eq(invitations.status, "pending"),
            targetInvitations(db, token, "invitation_control:apply"),
          ),
        ),
    );
  }
  statements.push(
    db
      .select({ kind: receipts.kind })
      .from(receipts)
      .where(eq(receipts.token, token)),
    db.delete(receipts).where(eq(receipts.token, token)),
  );
  return statements;
}

function decodeDecision(
  row: Record<string, unknown> | undefined,
): InvitationDecisionResult | "retry" {
  if (!row) return { notFound: true };
  const code = String(row.kind).slice("invitation_decision:".length);
  if (code === "retry") return "retry";
  if (code === "expired") return { expired: true };
  if (code === "unverified") return { emailUnverified: true };
  if (code === "mismatch") return { emailMismatch: true };
  if (code.startsWith("state:"))
    return { invalidState: code.slice(6) as InvitationStatus };
  return { ok: true, courseId: Number(row.course_id) };
}

function decodeControl(
  row: Record<string, unknown> | undefined,
): InvitationControlResult {
  if (!row) return { notFound: true };
  const code = String(row.kind).slice("invitation_control:".length);
  return code === "apply"
    ? { ok: true }
    : { invalidState: code.slice(6) as InvitationStatus };
}

export function createD1InvitationWriteRepository(
  database: D1Database,
  emailDelivery: boolean,
): InvitationWriteRepository {
  const db = createD1Connection(database);
  const prepare = (statement: Statement) => {
    const query = statement.toSQL();
    return database.prepare(query.sql).bind(...query.params);
  };
  // Receipt creation, guarded writes, result read, and cleanup must remain in
  // one atomic D1 batch. TS must not branch between these SQL statements.
  const executeMutation = async (statements: Statement[]) => {
    const results = await database.batch<Record<string, unknown>>(
      statements.map(prepare),
    );
    return results[statements.length - 2].results[0];
  };
  return {
    async decide(action, hash, userId, now) {
      const at = now.toISOString();
      for (let attempt = 0; attempt < 5; attempt++) {
        // JS and SQLite have different Unicode case conversion. Bind a normalized
        // email only while the exact source email/verification snapshot still holds.
        const user = await db
          .select({ email: users.email, emailVerified: users.emailVerified })
          .from(users)
          .where(eq(users.id, userId))
          .get();
        const token = crypto.randomUUID();
        const row = await executeMutation(
          buildDecisionStatements(db, action, hash, userId, at, token, user),
        );
        const result = decodeDecision(row);
        if (result !== "retry") return result;
      }
      throw new Error(
        "Invitation identity changed repeatedly; retry the operation",
      );
    },
    async control(action, courseId, invitationId, ownerId, now, replacement) {
      const effects = invitationControlEffects(action);
      if (effects.rotateToken && !replacement)
        throw new Error("Missing replacement token");
      const token = crypto.randomUUID(),
        at = now.toISOString();
      const row = await executeMutation(
        buildControlStatements(
          db,
          action,
          courseId,
          invitationId,
          ownerId,
          at,
          token,
          emailDelivery,
          now,
          replacement,
        ),
      );
      return decodeControl(row);
    },
    async remove(courseId, memberId, ownerId) {
      const ownedCourse = db
        .select({ id: videoCourses.id })
        .from(videoCourses)
        .where(
          and(eq(videoCourses.id, courseId), eq(videoCourses.userId, ownerId)),
        );
      const rows = await db
        .delete(videoCourseMemberships)
        .where(
          and(
            eq(videoCourseMemberships.courseId, courseId),
            eq(videoCourseMemberships.userId, memberId),
            exists(ownedCourse),
          ),
        )
        .returning({ id: videoCourseMemberships.id });
      return rows.length ? { ok: true } : { notFound: true };
    },
    async leave(courseId, userId) {
      const rows = await db
        .delete(videoCourseMemberships)
        .where(
          and(
            eq(videoCourseMemberships.courseId, courseId),
            eq(videoCourseMemberships.userId, userId),
          ),
        )
        .returning({ id: videoCourseMemberships.id });
      return rows.length ? { ok: true } : { notFound: true };
    },
  };
}
