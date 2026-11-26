import { and, eq, sql, exists, notExists, isNull } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  externalTasks,
  mutationReceipts as receipts,
  videoCourseInvitations as invitations,
  videoCourses,
  users,
} from "../../db/schema/sqlite";
import { nativeCourseExternalAccess } from "./course-access";
import {
  invitationDeliveryCutoff,
  invitationDeliveryStranded,
  invitationInviterName,
} from "../../domain/learning/invitation-delivery";
import { invitationDrizzleLogic } from "../invitation-policy-sql";
import {
  ExternalTaskLeaseLostError,
  type ExternalTaskLease,
} from "../contracts/external-task-repository";
import type { InvitationDeliveryRepository } from "../contracts/invitation-delivery-repository";
import type { InvitationStatus } from "../../domain/learning/course-invitations";

export function createD1InvitationDeliveryRepository(
  database: D1Database,
): InvitationDeliveryRepository {
  const db = createD1Connection(database);
  const nowSql = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const gate = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  const capture = (token: string, lease: ExternalTaskLease) =>
    db.insert(receipts).select(
      db
        .select(
          insertSelectFields(receipts, {
            token: sql`${token}`,
            kind: sql`'invitation_delivery'`,
            resourceId: externalTasks.id,
          }),
        )
        .from(externalTasks)
        .where(
          and(
            eq(externalTasks.id, lease.id),
            eq(externalTasks.attempts, lease.attempt),
            sql`julianday(${externalTasks.lockedAt})>julianday('now')-5.0/1440`,
            isNull(externalTasks.completedAt),
            isNull(externalTasks.deadAt),
          ),
        ),
    );
  const receipt = (token: string) =>
    db
      .select({ token: receipts.token })
      .from(receipts)
      .where(eq(receipts.token, token));
  const cleanup = (token: string) =>
    db.delete(receipts).where(eq(receipts.token, token));
  return {
    async record(outcomes, opts) {
      if (!outcomes.length && !opts.completeTask) return;
      const token = crypto.randomUUID();
      const statements: D1Query[] = [capture(token, opts.lease)];
      // Keep per-recipient order: the last outcome wins, every attempt counts,
      // and a failed attempt after a success must preserve the last sent time.
      for (const outcome of outcomes)
        statements.push(
          db
            .update(invitations)
            .set({
              deliveryStatus: outcome.status,
              lastError: outcome.error?.slice(0, 1000) ?? null,
              updatedAt: outcome.attemptedAt.toISOString(),
              sendAttempts: sql`${invitations.sendAttempts}+1`,
              ...(outcome.status === "sent"
                ? { lastSentAt: outcome.attemptedAt.toISOString() }
                : {}),
            })
            .where(and(eq(invitations.id, outcome.invitationId), gate(token))),
        );
      if (opts.completeTask)
        statements.push(
          db
            .update(externalTasks)
            .set({
              completedAt: nowSql,
              lockedAt: null,
              lastError: "",
              updatedAt: nowSql,
            })
            .where(and(eq(externalTasks.id, opts.lease.id), gate(token))),
        );
      const receiptIndex = statements.length;
      statements.push(receipt(token), cleanup(token));
      const result = await runD1Batch(database, statements);
      if (!result[receiptIndex].results.length)
        throw new ExternalTaskLeaseLostError();
    },
    async failStranded(now, graceMs) {
      const cutoff = invitationDeliveryCutoff(now, graceMs).toISOString();
      const noLiveTask = notExists(
        db
          .select({ id: externalTasks.id })
          .from(externalTasks)
          .where(
            and(
              eq(externalTasks.kind, "invitation_email"),
              isNull(externalTasks.completedAt),
              isNull(externalTasks.deadAt),
              sql`CAST(json_extract(${externalTasks.payload},'$.invitation_id') AS INTEGER)=${invitations.id}`,
            ),
          ),
      );
      const result = await db
        .update(invitations)
        .set({
          deliveryStatus: "failed",
          lastError: "Delivery task is no longer retrying.",
          updatedAt: now.toISOString(),
        })
        .where(
          invitationDeliveryStranded(
            {
              pending: eq(invitations.status, "pending"),
              queued: eq(invitations.deliveryStatus, "queued"),
              graceElapsed: sql`julianday(${invitations.updatedAt})<julianday(${cutoff})`,
              noLiveTask,
            },
            invitationDrizzleLogic,
          ),
        )
        .run();
      return { failed: result.meta.changes };
    },
    async rotate(id, hash, now, lease) {
      const token = crypto.randomUUID(),
        at = now.toISOString();
      const authority = exists(
        db
          .select({ id: videoCourses.id })
          .from(videoCourses)
          .innerJoin(users, eq(users.id, invitations.invitedByUserId))
          .where(
            and(
              eq(videoCourses.id, invitations.courseId),
              nativeCourseExternalAccess(),
            ),
          ),
      );
      const eligible = and(
        eq(invitations.id, id),
        eq(invitations.status, "pending"),
        gate(token),
        authority,
      );
      // Separate predicates preserve SQL NULL semantics for invalid expiry dates:
      // an unknown expiry neither expires the invitation nor rotates its hash.
      const result = await runD1Batch(database, [
        capture(token, lease),
        receipt(token),
        db
          .update(invitations)
          .set({ status: "expired", updatedAt: at })
          .where(
            and(
              eligible,
              sql`julianday(${invitations.expiresAt})<=julianday(${at})`,
            ),
          ),
        db
          .update(invitations)
          .set({ tokenHash: hash, updatedAt: at })
          .where(
            and(
              eligible,
              sql`julianday(${invitations.expiresAt})>julianday(${at})`,
            ),
          ),
        // The original operation touched updated_at even for an unknown expiry.
        db.update(invitations).set({ updatedAt: at }).where(eligible),
        db
          .select({
            status: invitations.status,
            email: invitations.email,
            course_name: sql<string>`${videoCourses.name}`.as("course_name"),
            inviter_name: sql<string>`${users.name}`.as("inviter_name"),
            inviter_username: sql<string>`${users.username}`.as(
              "inviter_username",
            ),
          })
          .from(invitations)
          .innerJoin(videoCourses, eq(videoCourses.id, invitations.courseId))
          .innerJoin(users, eq(users.id, invitations.invitedByUserId))
          .where(
            and(
              eq(invitations.id, id),
              nativeCourseExternalAccess(),
              gate(token),
            ),
          ),
        cleanup(token),
      ]);
      if (!result[1].results.length) throw new ExternalTaskLeaseLostError();
      const row = result[5].results[0];
      if (!row) return { notFound: true };
      if (row.status !== "pending")
        return { invalidState: row.status as InvitationStatus };
      return {
        email: String(row.email),
        courseName: String(row.course_name),
        inviterName: invitationInviterName(
          String(row.inviter_name),
          String(row.inviter_username),
        ),
      };
    },
  };
}
