import {features} from '../../lib/deployment';
import {normalizeInvitationEmail} from '@videoq/trpc/course-invitations';
import {and,eq,inArray,lte} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {users,videoCourses,videoCourseInvitations,videoCourseMemberships} from '../../db/schema';
import {nativeCourseExternalAccess} from './course-authority';
import {insertInvitationEmailTasks} from './invitation-email-outbox';
import {validateInvitationBatch,type PendingInvitationInput,type InvitationCreateRepository} from '../contracts/invitation-create-repository';
import type {Bindings} from '../../types/bindings';
export async function createPendingCourseInvitations(
  env: Bindings,
  courseId: number,
  ownerUserId: string,
  inputs: readonly PendingInvitationInput[],
): Promise<
  | { notFound: true }
  | {
      created: { id: number; email: string }[];
      alreadyMemberEmails: string[];
      alreadyPendingEmails: string[];
    }
> {
  validateInvitationBatch(inputs);
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      const ownerRows = await tx
        .select({ ownerEmail: users.email })
        .from(videoCourses)
        .innerJoin(users, eq(users.id, videoCourses.userId))
        .where(and(eq(videoCourses.id, courseId), eq(videoCourses.userId, ownerUserId), nativeCourseExternalAccess()))
        .limit(1)
        .for("update");
      if (ownerRows.length === 0) return { notFound: true } as const;

      const issuedAt = inputs[0]?.createdAt ?? new Date();
      await tx
        .update(videoCourseInvitations)
        .set({ status: "expired", updatedAt: issuedAt.toISOString() })
        .where(
          and(
            eq(videoCourseInvitations.courseId, courseId),
            eq(videoCourseInvitations.status, "pending"),
            lte(videoCourseInvitations.expiresAt, issuedAt.toISOString()),
          ),
        );

      const emails = inputs.map((input) => input.email);
      const alreadyMemberEmails = new Set<string>();
      const ownerEmail = normalizeInvitationEmail(ownerRows[0].ownerEmail);
      if (ownerEmail && emails.includes(ownerEmail)) alreadyMemberEmails.add(ownerEmail);

      if (emails.length > 0) {
        const memberRows = await tx
          .select({ email: users.email })
          .from(videoCourseMemberships)
          .innerJoin(users, eq(users.id, videoCourseMemberships.userId))
          .where(eq(videoCourseMemberships.courseId,courseId));
        for (const row of memberRows) {
          const email = normalizeInvitationEmail(row.email);
          if (email && emails.includes(email)) alreadyMemberEmails.add(email);
        }
      }

      const candidateInputs = inputs.filter(
        (input) => !alreadyMemberEmails.has(input.email),
      );
      const alreadyPendingEmails = new Set<string>();
      if (candidateInputs.length > 0) {
        const pendingRows = await tx
          .select({ email: videoCourseInvitations.email })
          .from(videoCourseInvitations)
          .where(
            and(
              eq(videoCourseInvitations.courseId, courseId),
              eq(videoCourseInvitations.status, "pending"),
              inArray(
                videoCourseInvitations.email,
                candidateInputs.map((input) => input.email),
              ),
            ),
          );
        for (const row of pendingRows) alreadyPendingEmails.add(row.email);
      }

      const insertInputs = candidateInputs.filter(
        (input) => !alreadyPendingEmails.has(input.email),
      );
      const inserted = insertInputs.length
        ? await tx
            .insert(videoCourseInvitations)
            .values(
              insertInputs.map((input) => ({
                courseId,
                email: input.email,
                invitedByUserId: ownerUserId,
                status: "pending",
                deliveryStatus: "queued",
                tokenHash: input.tokenHash,
                expiresAt: input.expiresAt.toISOString(),
                createdAt: input.createdAt.toISOString(),
                updatedAt: input.createdAt.toISOString(),
                sendAttempts: 0,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: videoCourseInvitations.id, email: videoCourseInvitations.email })
        : [];

      const insertedEmails = new Set(inserted.map((row) => row.email));
      for (const input of insertInputs) {
        if (!insertedEmails.has(input.email)) alreadyPendingEmails.add(input.email);
      }

      // 招待行と配送タスクを同じtransactionでコミットする（outbox）。
      // 招待だけ残ってメールが永久に送られない状態を作らない。
      if (features(env).emailDelivery) await insertInvitationEmailTasks(
        tx,
        inserted.map((row) => Number(row.id)),
        issuedAt,
      );

      return {
        created: inserted,
        alreadyMemberEmails: [...alreadyMemberEmails],
        alreadyPendingEmails: [...alreadyPendingEmails],
      };
    }),
  );
}

export function createPostgresInvitationCreateRepository(env:Bindings):InvitationCreateRepository{return {create:(course,owner,inputs)=>createPendingCourseInvitations(env,course,owner,inputs)};}
