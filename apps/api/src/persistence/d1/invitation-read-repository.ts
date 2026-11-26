import { invitationInviterName } from "../../domain/learning/invitation-delivery";
import { nativeCourseExternalAccess } from "./course-access";
import { and, desc, eq, exists } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  users,
  videoCourses,
  videoCourseInvitations as invitations,
  videoCourseMemberships as memberships,
} from "../../db/schema/sqlite/modern";
import {
  effectiveInvitationStatus,
  type InvitationStatus,
  type InvitationDeliveryStatus,
} from "../../lib/course-invitations";
import { toUtcIso } from "../../shared/datetime";
import type { InvitationReadRepository } from "../contracts/invitation-read-repository";
export function createD1InvitationReadRepository(
  database: D1Database,
): InvitationReadRepository {
  const db = drizzle(database);
  return {
    async participants(courseId, ownerId) {
      const owner = exists(
        db
          .select({ id: videoCourses.id })
          .from(videoCourses)
          .where(
            and(
              eq(videoCourses.id, courseId),
              eq(videoCourses.userId, ownerId),
            ),
          ),
      );
      const [owned, invites, members] = await db.batch([
        db
          .select({ id: videoCourses.id })
          .from(videoCourses)
          .where(
            and(
              eq(videoCourses.id, courseId),
              eq(videoCourses.userId, ownerId),
            ),
          )
          .limit(1),
        db
          .select({
            id: invitations.id,
            email: invitations.email,
            status: invitations.status,
            deliveryStatus: invitations.deliveryStatus,
            expiresAt: invitations.expiresAt,
            createdAt: invitations.createdAt,
            lastSentAt: invitations.lastSentAt,
            sendAttempts: invitations.sendAttempts,
          })
          .from(invitations)
          .where(and(eq(invitations.courseId, courseId), owner))
          .orderBy(desc(invitations.createdAt)),
        db
          .select({
            id: users.id,
            username: users.username,
            email: users.email,
            joinedAt: memberships.joinedAt,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.courseId, courseId), owner))
          .orderBy(desc(memberships.joinedAt)),
      ]);
      if (!owned.length) return { notFound: true };
      const now = new Date();
      return {
        invitations: invites.map((r) => ({
          id: r.id,
          email: r.email,
          status: effectiveInvitationStatus(
            r.status as InvitationStatus,
            new Date(r.expiresAt),
            now,
          ),
          delivery_status: r.deliveryStatus as InvitationDeliveryStatus,
          expires_at: toUtcIso(r.expiresAt),
          created_at: toUtcIso(r.createdAt),
          last_sent_at: r.lastSentAt ? toUtcIso(r.lastSentAt) : null,
          send_attempts: r.sendAttempts,
        })),
        members: members.map((r) => ({
          user_id: r.id,
          username: r.username,
          email: r.email,
          joined_at: toUtcIso(r.joinedAt),
        })),
      };
    },
    async preview(hash) {
      const native = nativeCourseExternalAccess();
      const [r] = await db
        .select({
          courseId: videoCourses.id,
          courseName: videoCourses.name,
          inviterName: users.name,
          inviterUsername: users.username,
          email: invitations.email,
          status: invitations.status,
          expiresAt: invitations.expiresAt,
        })
        .from(invitations)
        .innerJoin(videoCourses, eq(videoCourses.id, invitations.courseId))
        .innerJoin(users, eq(users.id, invitations.invitedByUserId))
        .where(and(eq(invitations.tokenHash, hash), native))
        .limit(1)
        .all();
      return r
        ? {
            course_id: r.courseId,
            course_name: r.courseName,
            inviter_name: invitationInviterName(
              r.inviterName,
              r.inviterUsername,
            ),
            email: r.email,
            status: r.status as InvitationStatus,
            expires_at: toUtcIso(r.expiresAt),
          }
        : null;
    },
  };
}
