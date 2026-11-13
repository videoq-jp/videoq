import {features} from '../../lib/deployment';
import {normalizeInvitationEmail} from '@videoq/trpc/course-invitations';
import {and,eq} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {users,videoCourseInvitations,videoCourseMemberships,videoCourses} from '../../db/schema';
import {effectiveInvitationStatus,isInvitationExpired,type InvitationStatus} from '../../lib/course-invitations';
import {nativeCourseExternalAccess} from './course-authority';
import {insertInvitationEmailTasks} from './invitation-email-outbox';
import type {Bindings} from '../../types/bindings';
import type {InvitationDecisionResult,InvitationWriteRepository} from '../contracts/invitation-write-repository';
export async function acceptCourseInvitation(
  env: Bindings,
  tokenHash: string,
  userId: string,
  now: Date,
): Promise<InvitationDecisionResult> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      // Lock the course before its invitation, matching creation's lock order.
      // Check even accepted-token replays: an old native grant cannot reopen
      // a course that has since become Moodle-controlled.
      const course = await tx.select({ id: videoCourses.id }).from(videoCourseInvitations)
        .innerJoin(videoCourses, eq(videoCourses.id, videoCourseInvitations.courseId))
        .where(and(eq(videoCourseInvitations.tokenHash, tokenHash), nativeCourseExternalAccess()))
        .limit(1).for('share', { of: videoCourses });
      if (!course.length) return { notFound: true } as const;
      const invitationRows = await tx
        .select({
          id: videoCourseInvitations.id,
          courseId: videoCourseInvitations.courseId,
          email: videoCourseInvitations.email,
          status: videoCourseInvitations.status,
          expiresAt: videoCourseInvitations.expiresAt,
          acceptedByUserId: videoCourseInvitations.acceptedByUserId,
        })
        .from(videoCourseInvitations)
        .where(eq(videoCourseInvitations.tokenHash, tokenHash))
        .limit(1)
        .for("update");
      if (invitationRows.length === 0) return { notFound: true } as const;

      const invitation = invitationRows[0];
      if (
        invitation.status === "accepted" &&
        invitation.acceptedByUserId === userId
      ) {
        return { ok: true, courseId: Number(invitation.courseId) } as const;
      }
      if (invitation.status !== "pending") {
        return { invalidState: invitation.status as InvitationStatus } as const;
      }
      if (isInvitationExpired(new Date(invitation.expiresAt), now)) {
        await tx
          .update(videoCourseInvitations)
          .set({ status: "expired", updatedAt: now.toISOString() })
          .where(eq(videoCourseInvitations.id, invitation.id));
        return { expired: true } as const;
      }

      const userRows = await tx
        .select({ email: users.email, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (userRows.length === 0 || !userRows[0].emailVerified) {
        return { emailUnverified: true } as const;
      }
      if (normalizeInvitationEmail(userRows[0].email) !== invitation.email) {
        return { emailMismatch: true } as const;
      }

      await tx
        .insert(videoCourseMemberships)
        .values({
          courseId: Number(invitation.courseId),
          userId,
          invitationId: Number(invitation.id),
          joinedAt: now.toISOString(),
        })
        .onConflictDoNothing();
      await tx
        .update(videoCourseInvitations)
        .set({
          status: "accepted",
          acceptedByUserId: userId,
          acceptedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .where(eq(videoCourseInvitations.id, invitation.id));
      return { ok: true, courseId: Number(invitation.courseId) } as const;
    }),
  );
}

export async function declineCourseInvitation(
  env: Bindings,
  tokenHash: string,
  userId: string,
  now: Date,
): Promise<InvitationDecisionResult> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const invitationRows = await tx
        .select({
          id: videoCourseInvitations.id,
          courseId: videoCourseInvitations.courseId,
          email: videoCourseInvitations.email,
          status: videoCourseInvitations.status,
          expiresAt: videoCourseInvitations.expiresAt,
        })
        .from(videoCourseInvitations)
        .where(eq(videoCourseInvitations.tokenHash, tokenHash))
        .limit(1)
        .for("update");
      if (invitationRows.length === 0) return { notFound: true } as const;
      const invitation = invitationRows[0];
      if (invitation.status !== "pending") {
        return { invalidState: invitation.status as InvitationStatus } as const;
      }
      if (isInvitationExpired(new Date(invitation.expiresAt), now)) {
        await tx
          .update(videoCourseInvitations)
          .set({ status: "expired", updatedAt: now.toISOString() })
          .where(eq(videoCourseInvitations.id, invitation.id));
        return { expired: true } as const;
      }
      const userRows = await tx
        .select({ email: users.email, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (userRows.length === 0 || !userRows[0].emailVerified) {
        return { emailUnverified: true } as const;
      }
      if (normalizeInvitationEmail(userRows[0].email) !== invitation.email) {
        return { emailMismatch: true } as const;
      }
      await tx
        .update(videoCourseInvitations)
        .set({ status: "declined", updatedAt: now.toISOString() })
        .where(eq(videoCourseInvitations.id, invitation.id));
      return { ok: true, courseId: Number(invitation.courseId) } as const;
    }),
  );
}

/**
 * 送信直前にトークンを差し替える。`pending` の招待だけが対象で、
 * enqueue から配送までの間に取り消し・承認された招待にはメールを送らない。
 * 有効期限は作成時のままにする（再試行で寿命が伸びないように）。
 */
export async function rotatePendingCourseInvitation(
  env: Bindings,
  courseId: number,
  invitationId: number,
  ownerUserId: string,
  tokenHash: string,
  expiresAt: Date,
  now: Date,
): Promise<
  | { notFound: true }
  | { invalidState: InvitationStatus }
  | { ok: true }
> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      // Match creation/acceptance: lock course authority before its invitation.
      const course=await tx.select({id:videoCourses.id}).from(videoCourses)
        .where(and(eq(videoCourses.id,courseId),eq(videoCourses.userId,ownerUserId)))
        .limit(1).for('update');
      if(!course.length)return {notFound:true} as const;
      const rows = await tx
        .select({
          status: videoCourseInvitations.status,
          expiresAt: videoCourseInvitations.expiresAt,
        })
        .from(videoCourseInvitations)
        .innerJoin(videoCourses, eq(videoCourses.id, videoCourseInvitations.courseId))
        .where(
          and(
            eq(videoCourseInvitations.id, invitationId),
            eq(videoCourseInvitations.courseId, courseId),
            eq(videoCourses.userId, ownerUserId),
            nativeCourseExternalAccess(),
          ),
        )
        .limit(1)
        .for("update");
      if (rows.length === 0) return { notFound: true } as const;
      const status = effectiveInvitationStatus(
        rows[0].status as InvitationStatus,
        new Date(rows[0].expiresAt),
        now,
      );
      if (status !== "pending") {
        if (status === "expired" && rows[0].status === "pending") {
          await tx
            .update(videoCourseInvitations)
            .set({ status: "expired", updatedAt: now.toISOString() })
            .where(eq(videoCourseInvitations.id, invitationId));
        }
        return { invalidState: status } as const;
      }
      // tokenHash は「誰も持っていないダミー」。古いリンクをここで即座に
      // 無効化し、実際に配る値は配送タスクが送信直前に発行する。
      await tx
        .update(videoCourseInvitations)
        .set({
          tokenHash,
          expiresAt: expiresAt.toISOString(),
          deliveryStatus: "queued",
          lastError: null,
          updatedAt: now.toISOString(),
        })
        .where(eq(videoCourseInvitations.id, invitationId));
      if (features(env).emailDelivery) await insertInvitationEmailTasks(tx, [invitationId], now);
      return { ok: true } as const;
    }),
  );
}

export async function revokePendingCourseInvitation(
  env: Bindings,
  courseId: number,
  invitationId: number,
  ownerUserId: string,
  now: Date,
): Promise<{ notFound: true } | { invalidState: InvitationStatus } | { ok: true }> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      // Match creation/acceptance: lock course authority before its invitation.
      const course=await tx.select({id:videoCourses.id}).from(videoCourses)
        .where(and(eq(videoCourses.id,courseId),eq(videoCourses.userId,ownerUserId)))
        .limit(1).for('update');
      if(!course.length)return {notFound:true} as const;
      const rows = await tx
        .select({
          status: videoCourseInvitations.status,
          expiresAt: videoCourseInvitations.expiresAt,
        })
        .from(videoCourseInvitations)
        .innerJoin(videoCourses, eq(videoCourses.id, videoCourseInvitations.courseId))
        .where(
          and(
            eq(videoCourseInvitations.id, invitationId),
            eq(videoCourseInvitations.courseId, courseId),
            eq(videoCourses.userId, ownerUserId),
          ),
        )
        .limit(1)
        .for("update");
      if (rows.length === 0) return { notFound: true } as const;
      const status = effectiveInvitationStatus(
        rows[0].status as InvitationStatus,
        new Date(rows[0].expiresAt),
        now,
      );
      if (status !== "pending") {
        if (status === "expired" && rows[0].status === "pending") {
          await tx
            .update(videoCourseInvitations)
            .set({ status: "expired", updatedAt: now.toISOString() })
            .where(eq(videoCourseInvitations.id, invitationId));
        }
        return { invalidState: status } as const;
      }
      await tx
        .update(videoCourseInvitations)
        .set({ status: "revoked", updatedAt: now.toISOString() })
        .where(eq(videoCourseInvitations.id, invitationId));
      return { ok: true } as const;
    }),
  );
}

export async function removeCourseUserMember(
  env: Bindings,
  courseId: number,
  memberUserId: string,
  ownerUserId: string,
): Promise<{ notFound: true } | { ok: true }> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const owner = await tx
        .select({ id: videoCourses.id })
        .from(videoCourses)
        .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, ownerUserId)))
        .limit(1);
      if (owner.length === 0) return { notFound: true } as const;
      const removed = await tx
        .delete(videoCourseMemberships)
        .where(
          and(
            eq(videoCourseMemberships.courseId, courseId),
            eq(videoCourseMemberships.userId, memberUserId),
          ),
        )
        .returning({ id: videoCourseMemberships.id });
      if (removed.length === 0) return { notFound: true } as const;
      return { ok: true } as const;
    }),
  );
}

export async function leaveCourseMembership(
  env: Bindings,
  courseId: number,
  userId: string,
): Promise<{ notFound: true } | { ok: true }> {
  return withDb(env, async (db) => {
    const removed = await db
      .delete(videoCourseMemberships)
      .where(
        and(
          eq(videoCourseMemberships.courseId, courseId),
          eq(videoCourseMemberships.userId, userId),
        ),
      )
      .returning({ id: videoCourseMemberships.id });
    return removed.length > 0 ? ({ ok: true } as const) : ({ notFound: true } as const);
  });
}

export function createPostgresInvitationWriteRepository(env:Bindings):InvitationWriteRepository{return {
 decide:(action,hash,user,now)=>action==='accept'?acceptCourseInvitation(env,hash,user,now):declineCourseInvitation(env,hash,user,now),
 control:(action,course,id,owner,now,replacement)=>{
  if(action==='resend'){if(!replacement)throw new Error('Missing replacement token');return rotatePendingCourseInvitation(env,course,id,owner,replacement.tokenHash,replacement.expiresAt,now);}
  return revokePendingCourseInvitation(env,course,id,owner,now);
 },remove:(course,member,owner)=>removeCourseUserMember(env,course,member,owner),leave:(course,user)=>leaveCourseMembership(env,course,user),
};}
