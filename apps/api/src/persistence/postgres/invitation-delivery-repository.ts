import { planInvitationControl } from "../../application/invitation-lifecycle";
import {
  invitationDeliveryCutoff,
  invitationDeliveryStranded,
  invitationDeliveryWasSent,
  invitationInviterName,
} from "../../application/invitation-delivery";
import { invitationDrizzleLogic } from "../invitation-policy-sql";
import { and, eq, lt, sql, notExists, isNull } from "drizzle-orm";
import { withDb } from "../../db/pool";
import {
  externalTasks,
  users,
  videoCourseInvitations,
  videoCourses,
} from "../../db/schema";
import { type InvitationStatus } from "../../lib/course-invitations";
import { lockExternalTaskLease } from "./external-task-repository";
import type { ExternalTaskLease } from "../contracts/external-task-repository";
import type {
  InvitationDeliveryOutcome,
  InvitationDeliveryRepository,
} from "../contracts/invitation-delivery-repository";
import { nativeCourseExternalAccess } from "./course-authority";
import type { Bindings } from "../../types/bindings";
/**
 * 配信結果と配送タスク完了を同じ transaction で記録する。
 * 成功・失敗のどちらも lease を確認し、古い実行者による上書きを防ぐ。
 */
export async function recordInvitationDeliveryOutcomes(
  env: Bindings,
  outcomes: readonly InvitationDeliveryOutcome[],
  opts: { lease: ExternalTaskLease; completeTask?: boolean },
): Promise<void> {
  if (outcomes.length === 0 && !opts.completeTask) return;
  await withDb(env, async (db) =>
    db.transaction(async (tx) => {
      await lockExternalTaskLease(tx, opts.lease);
      for (const outcome of outcomes) {
        await tx
          .update(videoCourseInvitations)
          .set({
            deliveryStatus: outcome.status,
            lastSentAt: invitationDeliveryWasSent(outcome.status, {
              equals: (status, expected) => status === expected,
            })
              ? outcome.attemptedAt.toISOString()
              : undefined,
            lastError: outcome.error?.slice(0, 1000) ?? null,
            sendAttempts: sql`${videoCourseInvitations.sendAttempts} + 1`,
            updatedAt: outcome.attemptedAt.toISOString(),
          })
          .where(eq(videoCourseInvitations.id, outcome.invitationId));
      }
      if (opts.completeTask) {
        await tx
          .update(externalTasks)
          .set({
            completedAt: sql`now()`,
            lockedAt: null,
            lastError: "",
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(externalTasks.id, opts.lease.id),
              sql`${externalTasks.completedAt} IS NULL`,
            ),
          );
      }
    }),
  );
}

/**
 * 配送タスクが尽きた（dead になった / そもそも存在しない）招待を `failed` にする。
 *
 * 再試行中のタスクが残っている招待には触らない。触ってしまうと、オーナーが
 * 「失敗」表示を見て再送 → 生きているタスクと二重にトークンを回転させ、
 * 届いたメールのリンクが片方死ぬ、という競合が起きる。
 */
export async function failInvitationsWithoutLiveDelivery(
  env: Bindings,
  now: Date,
  graceMs: number,
): Promise<{ failed: number }> {
  const cutoff = invitationDeliveryCutoff(now, graceMs).toISOString();
  return withDb(env, async (db) => {
    const rows = await db
      .update(videoCourseInvitations)
      .set({
        deliveryStatus: "failed",
        lastError: "Delivery task is no longer retrying.",
        updatedAt: now.toISOString(),
      })
      .where(
        invitationDeliveryStranded(
          {
            pending: eq(videoCourseInvitations.status, "pending"),
            queued: eq(videoCourseInvitations.deliveryStatus, "queued"),
            graceElapsed: lt(videoCourseInvitations.updatedAt, cutoff),
            noLiveTask: notExists(
              db
                .select({ id: externalTasks.id })
                .from(externalTasks)
                .where(
                  and(
                    eq(externalTasks.kind, "invitation_email"),
                    isNull(externalTasks.completedAt),
                    isNull(externalTasks.deadAt),
                    sql`(${externalTasks.payload}->>'invitation_id')::bigint=${videoCourseInvitations.id}`,
                  ),
                ),
            ),
          },
          invitationDrizzleLogic,
        ),
      )
      .returning({ id: videoCourseInvitations.id });
    return { failed: rows.length };
  });
}

export async function rotateInvitationTokenForDelivery(
  env: Bindings,
  invitationId: number,
  tokenHash: string,
  now: Date,
  lease: ExternalTaskLease,
): Promise<
  | { notFound: true }
  | { invalidState: InvitationStatus }
  | { email: string; courseName: string; inviterName: string }
> {
  return withDb(env, async (db) =>
    db.transaction(async (tx) => {
      await lockExternalTaskLease(tx, lease);
      const rows = await tx
        .select({
          id: videoCourseInvitations.id,
          email: videoCourseInvitations.email,
          status: videoCourseInvitations.status,
          expiresAt: videoCourseInvitations.expiresAt,
          courseName: videoCourses.name,
          inviterName: users.name,
          inviterUsername: users.username,
        })
        .from(videoCourseInvitations)
        .innerJoin(
          videoCourses,
          eq(videoCourses.id, videoCourseInvitations.courseId),
        )
        .innerJoin(users, eq(users.id, videoCourseInvitations.invitedByUserId))
        .where(
          and(
            eq(videoCourseInvitations.id, invitationId),
            nativeCourseExternalAccess(),
          ),
        )
        .limit(1)
        .for("update");
      if (rows.length === 0) return { notFound: true } as const;

      const plan = planInvitationControl(
        rows[0].status as InvitationStatus,
        new Date(rows[0].expiresAt),
        now,
      );
      if (plan.kind === "deny") {
        if (plan.markExpired) {
          await tx
            .update(videoCourseInvitations)
            .set({ status: "expired", updatedAt: now.toISOString() })
            .where(eq(videoCourseInvitations.id, invitationId));
        }
        return { invalidState: plan.status } as const;
      }

      await tx
        .update(videoCourseInvitations)
        .set({ tokenHash, updatedAt: now.toISOString() })
        .where(eq(videoCourseInvitations.id, invitationId));
      return {
        email: rows[0].email,
        courseName: rows[0].courseName,
        inviterName: invitationInviterName(
          rows[0].inviterName,
          rows[0].inviterUsername,
        ),
      };
    }),
  );
}

export function createPostgresInvitationDeliveryRepository(
  env: Bindings,
): InvitationDeliveryRepository {
  return {
    record: (outcomes, opts) =>
      recordInvitationDeliveryOutcomes(env, outcomes, opts),
    failStranded: (now, grace) =>
      failInvitationsWithoutLiveDelivery(env, now, grace),
    rotate: (id, hash, now, lease) =>
      rotateInvitationTokenForDelivery(env, id, hash, now, lease),
  };
}
