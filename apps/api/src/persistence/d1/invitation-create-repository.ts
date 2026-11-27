import { and, eq, sql, exists, notExists } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  users,
  videoCourses,
  videoCourseMemberships as memberships,
  videoCourseInvitations as invitations,
  mutationReceipts as receipts,
  externalTasks,
} from "../../db/schema/sqlite";
import { nativeCourseExternalAccess } from "./course-access";
import {
  invitationMemberEmails,
  uncreatedInvitationEmails,
  invitationCandidates,
  invitationPendingExpired,
} from "../../domain/learning/invitation-creation";
import { invitationDrizzleLogic } from "../invitation-policy-sql";
import {
  validateInvitationBatch,
  type InvitationCreateRepository,
} from "../contracts/invitation-create-repository";

export function createD1InvitationCreateRepository(
  database: D1Database,
  emailDelivery: boolean,
): InvitationCreateRepository {
  const db = createD1Connection(database);
  const memberRows = db
    .select({ id: memberships.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.courseId, videoCourses.id))
    .orderBy(memberships.id)
    .as("member");
  const members = db
    .select({
      value: sql<string>`json_group_array(json_array(${memberRows.id},${memberRows.email}))`,
    })
    .from(memberRows);
  return {
    async create(courseId, ownerId, inputs) {
      validateInvitationBatch(inputs);
      const issuedAt = inputs[0]?.createdAt ?? new Date();
      for (let attempt = 0; attempt < 5; attempt++) {
        const snapshot = await db
          .select({
            ownerEmail: users.email,
            members: sql<string>`(${members})`,
          })
          .from(videoCourses)
          .innerJoin(users, eq(users.id, videoCourses.userId))
          .where(
            and(
              eq(videoCourses.id, courseId),
              eq(videoCourses.userId, ownerId),
              nativeCourseExternalAccess(),
            ),
          )
          .get();
        if (!snapshot) return { notFound: true };
        const memberEmails = (
          JSON.parse(snapshot.members) as [number, string][]
        ).map(([, email]) => email);
        const alreadyMembers = invitationMemberEmails(
          inputs,
          snapshot.ownerEmail,
          memberEmails,
        );
        const token = crypto.randomUUID();
        const gate = exists(
          db
            .select({ token: receipts.token })
            .from(receipts)
            .where(eq(receipts.token, token)),
        );
        const statements: D1Query[] = [
          db.insert(receipts).select(
            db
              .select(
                insertSelectFields(receipts, {
                  token: sql`${token}`,
                  kind: sql`'invitation_create'`,
                  resourceId: videoCourses.id,
                }),
              )
              .from(videoCourses)
              .innerJoin(users, eq(users.id, videoCourses.userId))
              .where(
                and(
                  eq(videoCourses.id, courseId),
                  eq(videoCourses.userId, ownerId),
                  eq(users.email, snapshot.ownerEmail),
                  sql`(${members})=${snapshot.members}`,
                  nativeCourseExternalAccess(),
                ),
              ),
          ),
          db
            .update(invitations)
            .set({ status: "expired", updatedAt: issuedAt.toISOString() })
            .where(
              and(
                eq(invitations.courseId, courseId),
                invitationPendingExpired(
                  eq(invitations.status, "pending"),
                  sql`julianday(${invitations.expiresAt})<=julianday(${issuedAt.toISOString()})`,
                  invitationDrizzleLogic,
                ),
                gate,
              ),
            ),
        ];
        for (const input of invitationCandidates(inputs, alreadyMembers)) {
          const pending = db
            .select({ id: invitations.id })
            .from(invitations)
            .where(
              and(
                eq(invitations.courseId, courseId),
                eq(invitations.email, input.email),
                eq(invitations.status, "pending"),
              ),
            );
          statements.push(
            db
              .insert(invitations)
              .select(
                db
                  .select(
                    insertSelectFields(invitations, {
                      courseId: sql`${courseId}`,
                      email: sql`${input.email}`,
                      invitedByUserId: sql`${ownerId}`,
                      tokenHash: sql`${input.tokenHash}`,
                      expiresAt: sql`${input.expiresAt.toISOString()}`,
                      createdAt: sql`${input.createdAt.toISOString()}`,
                      updatedAt: sql`${input.createdAt.toISOString()}`,
                      creationNonce: sql`${token}`,
                    }),
                  )
                  .from(receipts)
                  .where(and(eq(receipts.token, token), notExists(pending))),
              )
              .onConflictDoNothing(),
          );
        }
        if (emailDelivery)
          statements.push(
            db
              .insert(externalTasks)
              .select(
                db
                  .select(
                    insertSelectFields(externalTasks, {
                      kind: sql`'invitation_email'`,
                      payload: sql`json_object('invitation_id',${invitations.id})`,
                      dedupeKey: sql`'invitation_email:'||${invitations.id}||':'||${issuedAt.getTime()}`,
                    }),
                  )
                  .from(invitations)
                  .where(and(eq(invitations.creationNonce, token), gate)),
              )
              .onConflictDoNothing(),
          );
        const createdIndex = statements.length;
        statements.push(
          db
            .select({ id: invitations.id, email: invitations.email })
            .from(invitations)
            .where(and(eq(invitations.creationNonce, token), gate))
            .orderBy(invitations.id),
          db
            .select({ token: receipts.token })
            .from(receipts)
            .where(eq(receipts.token, token)),
          db
            .update(invitations)
            .set({ creationNonce: null })
            .where(eq(invitations.creationNonce, token)),
          db.delete(receipts).where(eq(receipts.token, token)),
        );
        const result = await runD1Batch(database, statements);
        if (!result[createdIndex + 1].results.length) continue;
        const created = result[createdIndex].results.map((row) => ({
          id: Number(row.id),
          email: String(row.email),
        }));
        return {
          created,
          alreadyMemberEmails: alreadyMembers,
          alreadyPendingEmails: uncreatedInvitationEmails(
            inputs,
            alreadyMembers,
            created.map((row) => row.email),
          ),
        };
      }
      throw new Error(
        "Course membership changed repeatedly; retry invitation creation",
      );
    },
  };
}
