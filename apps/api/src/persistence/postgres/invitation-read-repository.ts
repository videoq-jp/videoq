import {and,desc,eq} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {users,videoCourseInvitations,videoCourseMemberships,videoCourses} from '../../db/schema';
import {effectiveInvitationStatus,type InvitationStatus,type InvitationDeliveryStatus} from '../../lib/course-invitations';
import {toUtcIso} from '../../shared/datetime';
import {nativeCourseExternalAccess} from './course-authority';
import type {Bindings} from '../../types/bindings';
import type {CourseInvitationListItem,CourseUserMemberListItem,InvitationPreviewRecord,InvitationReadRepository} from '../contracts/invitation-read-repository';
export async function listCourseParticipants(
  env: Bindings,
  courseId: number,
  ownerUserId: string,
): Promise<
  | { notFound: true }
  | { invitations: CourseInvitationListItem[]; members: CourseUserMemberListItem[] }
> {
  return withDb(env, async (db) => {
    const owner = await db
      .select({ id: videoCourses.id })
      .from(videoCourses)
      .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, ownerUserId)))
      .limit(1);
    if (owner.length === 0) return { notFound: true } as const;

    const now = new Date();
    const [invitationRows, memberRows] = await Promise.all([
      db
        .select({
          id: videoCourseInvitations.id,
          email: videoCourseInvitations.email,
          status: videoCourseInvitations.status,
          deliveryStatus: videoCourseInvitations.deliveryStatus,
          expiresAt: videoCourseInvitations.expiresAt,
          createdAt: videoCourseInvitations.createdAt,
          lastSentAt: videoCourseInvitations.lastSentAt,
          sendAttempts: videoCourseInvitations.sendAttempts,
        })
        .from(videoCourseInvitations)
        .where(eq(videoCourseInvitations.courseId, courseId))
        .orderBy(desc(videoCourseInvitations.createdAt)),
      db
        .select({
          userId: users.id,
          username: users.username,
          email: users.email,
          joinedAt: videoCourseMemberships.joinedAt,
        })
        .from(videoCourseMemberships)
        .innerJoin(users, eq(users.id, videoCourseMemberships.userId))
        .where(eq(videoCourseMemberships.courseId, courseId))
        .orderBy(desc(videoCourseMemberships.joinedAt)),
    ]);

    return {
      invitations: invitationRows.map((row) => ({
        id: Number(row.id),
        email: row.email,
        status: effectiveInvitationStatus(row.status as InvitationStatus, new Date(row.expiresAt), now),
        delivery_status: row.deliveryStatus as InvitationDeliveryStatus,
        expires_at: toUtcIso(row.expiresAt),
        created_at: toUtcIso(row.createdAt),
        last_sent_at: row.lastSentAt ? toUtcIso(row.lastSentAt) : null,
        send_attempts: row.sendAttempts,
      })),
      members: memberRows.map((row) => ({
        user_id: row.userId,
        username: row.username,
        email: row.email,
        joined_at: toUtcIso(row.joinedAt),
      })),
    };
  });
}

export async function getCourseInvitationByTokenHash(
  env: Bindings,
  tokenHash: string,
): Promise<InvitationPreviewRecord | null> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({
        courseId: videoCourses.id,
        courseName: videoCourses.name,
        inviterName: users.name,
        inviterUsername: users.username,
        email: videoCourseInvitations.email,
        status: videoCourseInvitations.status,
        expiresAt: videoCourseInvitations.expiresAt,
      })
      .from(videoCourseInvitations)
      .innerJoin(videoCourses, eq(videoCourses.id, videoCourseInvitations.courseId))
      .innerJoin(users, eq(users.id, videoCourseInvitations.invitedByUserId))
      .where(and(eq(videoCourseInvitations.tokenHash, tokenHash), nativeCourseExternalAccess()))
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      course_id: Number(row.courseId),
      course_name: row.courseName,
      inviter_name: row.inviterName.trim() || row.inviterUsername,
      email: row.email,
      status: row.status as InvitationStatus,
      expires_at: toUtcIso(row.expiresAt),
    };
  });
}


export function createPostgresInvitationReadRepository(env:Bindings):InvitationReadRepository{return {
 participants:(id,owner)=>listCourseParticipants(env,id,owner),preview:hash=>getCourseInvitationByTokenHash(env,hash),
};}
