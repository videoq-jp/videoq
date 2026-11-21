import { alias } from "drizzle-orm/sqlite-core";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  adminSelfLockout,
  adminAssignedRole,
  adminRoleIncludes,
  adminBooleanRoleLogic,
  adminDeletionAllowed,
  planAdminQuotaEdit,
} from "../../application/admin";
import { billingAccountAvailable } from "../../application/billing-state";
import { billingDrizzleBanLogic } from "../billing-policy-sql";
import {
  adminD1RoleLogic,
  adminDrizzleNegation,
  subscriptionDrizzleChoice,
} from "../admin-policy-sql";
import { APIError } from "better-auth/api";
import type { Bindings } from "../../types/bindings";
import {
  session,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
} from "../../db/schema/sqlite/better-auth";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  sql,
  exists,
  isNull,
} from "drizzle-orm";
import { toUtcIso } from "../../shared/datetime";
import { drizzle } from "drizzle-orm/d1";
import { users, externalTasks } from "../../db/schema/sqlite/modern";
import { literalSearchPage } from "../../shared/literal-search";
import {
  buildJobMessage,
  JOB_DELETE_ACCOUNT_DATA,
} from "../../lib/job-message";
import {
  PLAN_CATALOG,
  subscriptionEntitlement,
} from "../../application/billing-catalog";
import type {
  AdminUser,
  AdminUserRepository,
} from "../contracts/admin-user-repository";
const selected = {
  id: users.id,
  username: users.username,
  email: users.email,
  is_active: sql<number>`${billingAccountAvailable({ banned: sql`COALESCE(${users.banned},0)`, noExpiry: sql`${users.banExpires} IS NULL`, expires: sql`julianday(${users.banExpires})`, now: sql`julianday('now')` }, billingDrizzleBanLogic)}`,
  is_admin: adminRoleIncludes(users.role, adminD1RoleLogic),
  max_video_upload_size_mb: users.maxVideoUploadSizeMb,
  storage_limit_gb: users.storageLimitGb,
  monthly_upload_limit_gb: users.monthlyUploadLimitGb,
  processing_limit_minutes: users.processingLimitMinutes,
  ai_answers_limit: users.aiAnswersLimit,
  used_storage_bytes: users.usedStorageBytes,
  used_processing_seconds: users.usedProcessingSeconds,
  used_ai_answers: users.usedAiAnswers,
  usage_period_start: users.usagePeriodStart,
  is_over_quota: users.isOverQuota,
  plan_code: users.planCode,
  quota_source: users.quotaSource,
};
function map(
  row: Omit<AdminUser, "is_active" | "is_admin" | "quota_source"> & {
    is_active: number;
    is_admin: number;
    quota_source: string;
  },
): AdminUser {
  return {
    ...row,
    usage_period_start:
      row.usage_period_start === null ? null : toUtcIso(row.usage_period_start),
    is_active: Boolean(row.is_active),
    is_admin: Boolean(row.is_admin),
    is_over_quota: Boolean(row.is_over_quota),
    quota_source: row.quota_source === "admin" ? "admin" : "plan",
  };
}
export function createD1AdminUserRepository(
  database: D1Database,
  env: Bindings,
  headers: Headers = new Headers(),
): AdminUserRepository {
  const db = drizzle(database);
  const find = async (id: string) => {
    const [row] = await db
      .select(selected)
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
      .all();
    return row ? map(row) : null;
  };
  return {
    async patchFlags(actorId, targetId, patch) {
      if (adminSelfLockout(actorId, targetId, patch))
        throw new APIError("BAD_REQUEST", {
          message:
            "Cannot deactivate yourself or remove your own administrator role.",
        });
      if (patch.is_active === undefined && patch.is_admin === undefined)
        return find(targetId);
      const { createD1Auth } = await import("./auth");
      const native = createD1Auth(env, database, "browser");
      const permission = await native.api.userHasPermission({
        headers,
        body: {
          permissions: {
            user: [
              ...(patch.is_active !== undefined ? ["ban" as const] : []),
              ...(patch.is_admin !== undefined ? ["set-role" as const] : []),
            ],
          },
        },
      });
      if (!permission.success)
        throw new APIError("FORBIDDEN", {
          message: "Administrator permission required.",
        });
      const auth = await native.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });
      if (!auth || auth.user.id !== actorId)
        throw new APIError("UNAUTHORIZED", {
          message: "Invalid administrator session.",
        });
      const actor = alias(users, "admin_actor"),
        activeSession = alias(session, "admin_session");
      const authority = exists(
        db
          .select({ id: activeSession.id })
          .from(activeSession)
          .innerJoin(actor, eq(actor.id, activeSession.userId))
          .where(
            and(
              eq(activeSession.id, auth.session.id),
              eq(activeSession.token, auth.session.token),
              eq(actor.id, actorId),
              sql`julianday(${activeSession.expiresAt})>julianday('now')`,
              adminRoleIncludes(actor.role, adminD1RoleLogic),
              billingAccountAvailable(
                {
                  banned: sql`coalesce(${actor.banned},0)`,
                  noExpiry: isNull(actor.banExpires),
                  expires: sql`julianday(${actor.banExpires})`,
                  now: sql`julianday('now')`,
                },
                billingDrizzleBanLogic,
              ),
            ),
          ),
      );
      const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
      if (patch.is_active !== undefined) {
        set.banned = !patch.is_active;
        set.banExpires = null;
        set.banReason = patch.is_active ? null : "No reason";
      }
      if (patch.is_admin !== undefined)
        set.role = adminAssignedRole(patch.is_admin);
      const result = await db
        .batch([
          db
            .select({ allowed: sql<number>`${authority}` })
            .from(users)
            .where(eq(users.id, actorId))
            .limit(1),
          db
            .update(users)
            .set(set)
            .where(and(eq(users.id, targetId), authority)),
          db
            .delete(session)
            .where(
              and(
                eq(session.userId, targetId),
                sql`${patch.is_active === false ? 1 : 0}`,
                authority,
              ),
            ),
          db
            .select(selected)
            .from(users)
            .where(and(eq(users.id, targetId), authority))
            .limit(1),
        ])
        .catch(() => {
          // Drizzle errors include bound parameters, including the session token.
          // Never pass those errors to the request logger or attach them as a cause.
          throw new Error("Administrator flag persistence failed.");
        });
      if (!result[0][0]?.allowed)
        throw new APIError("FORBIDDEN", {
          message: "Administrator authorization changed.",
        });
      return result[3][0] ? map(result[3][0]) : null;
    },
    async lockForHardDelete(id) {
      const message = buildJobMessage(JOB_DELETE_ACCOUNT_DATA, { user_id: id }),
        dedupe = `account-delete:${id}`;
      const role = adminRoleIncludes(users.role, adminD1RoleLogic);
      const eligible = exists(
        db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, id),
              adminDeletionAllowed(role, adminDrizzleNegation),
            ),
          ),
      );
      const result = await runD1Batch(database, [
        db
          .select({ is_admin: role.as("is_admin") })
          .from(users)
          .where(eq(users.id, id)),
        db
          .update(users)
          .set({ banned: true, banExpires: null })
          .where(and(eq(users.id, id), eligible)),
        db.delete(session).where(and(eq(session.userId, id), eligible)),
        db
          .delete(oauthAccessToken)
          .where(and(eq(oauthAccessToken.userId, id), eligible)),
        db
          .update(oauthRefreshToken)
          .set({ revoked: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')` })
          .where(
            and(
              eq(oauthRefreshToken.userId, id),
              isNull(oauthRefreshToken.revoked),
              eligible,
            ),
          ),
        db
          .delete(oauthConsent)
          .where(and(eq(oauthConsent.userId, id), eligible)),
        db
          .insert(externalTasks)
          .select(
            db
              .select(
                insertSelectFields(externalTasks, {
                  kind: sql`'sqs_job'`,
                  payload: sql`${JSON.stringify({ message })}`,
                  dedupeKey: sql`${dedupe}`,
                }),
              )
              .from(users)
              .where(
                and(
                  eq(users.id, id),
                  adminDeletionAllowed(role, adminDrizzleNegation),
                ),
              ),
          )
          .onConflictDoNothing({ target: externalTasks.dedupeKey }),
        db
          .select({
            id: externalTasks.id,
            job_id:
              sql`CASE WHEN json_type(${externalTasks.payload},'$.message.job_id')='text'
      AND length(json_extract(${externalTasks.payload},'$.message.job_id'))>0 THEN json_extract(${externalTasks.payload},'$.message.job_id')
      ELSE json('INVALID_DELETION_JOB') END`.as("job_id"),
          })
          .from(externalTasks)
          .where(and(eq(externalTasks.dedupeKey, dedupe), eligible)),
      ]);
      const target = result[0].results[0];
      if (!target) return { notFound: true };
      if (
        !adminDeletionAllowed(Boolean(target.is_admin), {
          not: (value) => !value,
        })
      )
        return { forbiddenAdmin: true };
      const task = result[7].results[0];
      if (!task || typeof task.job_id !== "string")
        throw new Error("Persisted deletion job ID is missing.");
      return { taskId: Number(task.id), jobId: task.job_id };
    },
    async isAdmin(id) {
      const [row] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, id))
        .limit(1)
        .all();
      return adminRoleIncludes(row?.role, adminBooleanRoleLogic);
    },
    async list(q, limit, offset) {
      if (!q) {
        const [totals, rows] = await db.batch([
          db.select({ n: count() }).from(users),
          db
            .select(selected)
            .from(users)
            .orderBy(asc(users.id))
            .limit(limit)
            .offset(offset),
        ]);
        return { count: totals[0].n, results: rows.map(map) };
      }
      const result = await literalSearchPage(
        q,
        limit,
        offset,
        (after) =>
          db
            .select({
              id: users.id,
              username: users.username,
              email: users.email,
            })
            .from(users)
            .where(after === null ? undefined : gt(users.id, after))
            .orderBy(asc(users.id))
            .limit(200)
            .all(),
        (row) => [row.username, row.email],
      );
      if (!result.ids.length) return { count: result.count, results: [] };
      const rows = await db
        .select(selected)
        .from(users)
        .where(inArray(users.id, result.ids))
        .orderBy(asc(users.id))
        .all();
      return { count: result.count, results: rows.map(map) };
    },
    find,
    async patchQuota(id, patch) {
      const plan = planAdminQuotaEdit(patch);
      if (plan.kind === "restorePlan") {
        const entitlement = <
          K extends keyof typeof PLAN_CATALOG.free.entitlements,
        >(
          key: K,
        ) =>
          subscriptionEntitlement(
            users.planCode,
            users.subscriptionStatus,
            {
              pro: sql`${PLAN_CATALOG.pro.entitlements[key]}`,
              basic: sql`${PLAN_CATALOG.basic.entitlements[key]}`,
              free: sql`${PLAN_CATALOG.free.entitlements[key]}`,
            },
            subscriptionDrizzleChoice,
          );
        const [row] = await db
          .update(users)
          .set({
            quotaSource: "plan",
            updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
            maxVideoUploadSizeMb: entitlement("maxVideoUploadSizeMb"),
            storageLimitGb: entitlement("storageLimitGb"),
            monthlyUploadLimitGb: entitlement("monthlyUploadLimitGb"),
            processingLimitMinutes: entitlement("processingLimitMinutes"),
            aiAnswersLimit: entitlement("aiAnswersLimit"),
          })
          .where(eq(users.id, id))
          .returning(selected)
          .all();
        return row ? map(row) : null;
      }
      if (plan.kind === "unchanged") return find(id);
      const [row] = await db
        .update(users)
        .set(plan.fields)
        .where(eq(users.id, id))
        .returning(selected)
        .all();
      return row ? map(row) : null;
    },
    async patchUsage(id, patch) {
      const set: Partial<typeof users.$inferInsert> = {};
      if (patch.used_storage_bytes !== undefined)
        set.usedStorageBytes = patch.used_storage_bytes;
      if (patch.used_processing_seconds !== undefined)
        set.usedProcessingSeconds = patch.used_processing_seconds;
      if (patch.used_ai_answers !== undefined)
        set.usedAiAnswers = patch.used_ai_answers;
      if (patch.usage_period_start !== undefined)
        set.usagePeriodStart = patch.usage_period_start;
      if (patch.is_over_quota !== undefined)
        set.isOverQuota = patch.is_over_quota;
      if (!Object.keys(set).length) return find(id);
      const [row] = await db
        .update(users)
        .set(set)
        .where(eq(users.id, id))
        .returning(selected)
        .all();
      return row ? map(row) : null;
    },
  };
}
