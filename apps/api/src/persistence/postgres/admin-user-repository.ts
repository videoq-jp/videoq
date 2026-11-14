import {createAuth} from "./auth";
import {toUtcIso} from "../../shared/datetime";
import { and, asc, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { RpcInputMap } from "@videoq/trpc";
import { withDb, type Db } from "../../db/pool";
import {literalSearchPage} from "../../shared/literal-search";
import {
  externalTasks,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
  users,
} from "../../db/schema";
import { insertJobTask } from "./external-task-repository";
import { entitlementsForSubscription } from "../../features/billing/catalog";
import {
  buildJobMessage,
  JOB_DELETE_ACCOUNT_DATA,
} from "../../lib/job-message";
import type { Bindings } from "../../types/bindings";

import type { AdminUser, AdminUserRepository } from "../contracts/admin-user-repository";
const usagePeriodStartText = sql<string | null>`${users.usagePeriodStart}::text`.as(
  "usage_period_start",
);

const adminUserSelect = {
  id: users.id,
  username: users.username,
  email: users.email,
  is_active: sql<boolean>`NOT (COALESCE(${users.banned}, false) AND (${users.banExpires} IS NULL OR ${users.banExpires} >= now()))`.as("is_active"),
  is_admin: sql<boolean>`COALESCE('admin' = ANY(string_to_array(${users.role}, ',')), false)`.as("is_admin"),
  max_video_upload_size_mb: users.maxVideoUploadSizeMb,
  storage_limit_gb: users.storageLimitGb,
  monthly_upload_limit_gb: users.monthlyUploadLimitGb,
  processing_limit_minutes: users.processingLimitMinutes,
  ai_answers_limit: users.aiAnswersLimit,
  used_storage_bytes: users.usedStorageBytes,
  used_processing_seconds: users.usedProcessingSeconds,
  used_ai_answers: users.usedAiAnswers,
  usage_period_start: usagePeriodStartText,
  is_over_quota: users.isOverQuota,
  plan_code: users.planCode,
  quota_source: users.quotaSource,
};

function mapUser(r: {
  id: string;
  username: string;
  email: string;
  is_active: boolean;
  is_admin: boolean;
  max_video_upload_size_mb: number;
  storage_limit_gb: number | null;
  monthly_upload_limit_gb: number | null;
  processing_limit_minutes: number | null;
  ai_answers_limit: number | null;
  used_storage_bytes: number;
  used_processing_seconds: number;
  used_ai_answers: number;
  usage_period_start: string | null;
  is_over_quota: boolean;
  plan_code: string;
  quota_source: string;
}): AdminUser {
  return {
    id: String(r.id),
    username: r.username,
    email: r.email,
    is_active: Boolean(r.is_active),
    is_admin: Boolean(r.is_admin),
    max_video_upload_size_mb: Number(r.max_video_upload_size_mb),
    monthly_upload_limit_gb: r.monthly_upload_limit_gb === null ? null : Number(r.monthly_upload_limit_gb),
    storage_limit_gb: r.storage_limit_gb === null ? null : Number(r.storage_limit_gb),
    processing_limit_minutes:
      r.processing_limit_minutes === null ? null : Number(r.processing_limit_minutes),
    ai_answers_limit: r.ai_answers_limit === null ? null : Number(r.ai_answers_limit),
    used_storage_bytes: Number(r.used_storage_bytes),
    used_processing_seconds: Number(r.used_processing_seconds),
    used_ai_answers: Number(r.used_ai_answers),
    usage_period_start: r.usage_period_start == null ? null : toUtcIso(r.usage_period_start),
    is_over_quota: Boolean(r.is_over_quota),
    plan_code: r.plan_code,
    quota_source: r.quota_source === "admin" ? "admin" : "plan",
  };
}

export async function isAdmin(env: Bindings, userId: string): Promise<boolean> {
  return withDb(env, async (db) => {
    const rows = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (rows.length === 0) return false;
    return rows[0].role?.split(",").includes("admin") ?? false;
  });
}

export async function listAdminUsers(
  env: Bindings,
  q: string,
  limit: number,
  offset: number,
): Promise<{ count: number; results: AdminUser[] }> {
  return withDb(env, async (db) => {
    if(!q){
      const [total]=await db.select({n:count()}).from(users);
      const rows=await db.select(adminUserSelect).from(users).orderBy(asc(users.id)).limit(limit).offset(offset);
      return {count:total.n,results:rows.map(mapUser)};
    }
    const result=await literalSearchPage(q,limit,offset,after=>db.select({id:users.id,username:users.username,email:users.email}).from(users).where(after===null?undefined:gt(users.id,after)).orderBy(asc(users.id)).limit(200),row=>[row.username,row.email]);
    if(!result.ids.length)return {count:result.count,results:[]};
    const rows=await db.select(adminUserSelect).from(users).where(inArray(users.id,result.ids)).orderBy(asc(users.id));
    return {count:result.count,results:rows.map(mapUser)};
  });
}

export async function getAdminUser(
  env: Bindings,
  userId: string,
): Promise<AdminUser | null> {
  return withDb(env, db => readAdminUser(db, userId));
}

async function readAdminUser(db: Db, userId: string): Promise<AdminUser | null> {
  const [user] = await db
    .select(adminUserSelect)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ? mapUser(user) : null;
}

/** Keep native auth changes and the response on the same locked user and connection. */
async function updateAdminUser(
  env: Bindings,
  userId: string,
  update: (tx: Db) => Promise<void>,
): Promise<AdminUser | null> {
  return withDb(env, db => db.transaction(async tx => {
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!target) return null;
    await update(tx);
    return readAdminUser(tx, userId);
  }));
}

export async function patchAdminUserQuota(
  env: Bindings,
  userId: string,
  patch: Omit<RpcInputMap["admin.patchQuota"], "id">,
): Promise<AdminUser | null> {
  if (patch.quota_source === "plan") {
    return withDb(env, db => db.transaction(async tx => {
      const [user] = await tx
        .select({ planCode: users.planCode, subscriptionStatus: users.subscriptionStatus })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!user) return null;
      const [updated] = await tx.update(users).set({
        ...entitlementsForSubscription(user.planCode, user.subscriptionStatus),
        quotaSource: "plan",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(users.id, userId)).returning(adminUserSelect);
      return updated ? mapUser(updated) : null;
    }));
  }

  const set: Partial<{
    monthlyUploadLimitGb: number | null;
    storageLimitGb: number | null;
    processingLimitMinutes: number | null;
    aiAnswersLimit: number | null;
    quotaSource: "plan" | "admin";
  }> = {};
  if (patch.monthly_upload_limit_gb !== undefined) {
    set.monthlyUploadLimitGb = patch.monthly_upload_limit_gb;
  }
  if (patch.storage_limit_gb !== undefined) set.storageLimitGb = patch.storage_limit_gb;
  if (patch.processing_limit_minutes !== undefined) {
    set.processingLimitMinutes = patch.processing_limit_minutes;
  }
  if (patch.ai_answers_limit !== undefined) set.aiAnswersLimit = patch.ai_answers_limit;
  if (patch.quota_source !== undefined) set.quotaSource = patch.quota_source;
  else if (Object.keys(set).length > 0) set.quotaSource = "admin";
  if (Object.keys(set).length === 0) return getAdminUser(env, userId);

  return withDb(env, async (db) => {
    const rows = await db
      .update(users)
      .set(set)
      .where(eq(users.id, userId))
      .returning(adminUserSelect);
    return rows[0] ? mapUser(rows[0]) : null;
  });
}

export async function lockUserForHardDelete(
  env: Bindings,
  userId: string,
): Promise<{ notFound: true } | { forbiddenAdmin: true } | { taskId: number; jobId: string }> {
  return withDb(env, async (db) => {
    return db.transaction(async (tx) => {
      const [target] = await tx
        .select({ is_admin: adminUserSelect.is_admin })
        .from(users)
        .where(eq(users.id, userId))
        .for("update")
        .limit(1);
      if (!target) return { notFound: true };
      if (target.is_admin) return { forbiddenAdmin: true };

      await tx
        .update(users)
        .set({ banned: true, banExpires: null })
        .where(eq(users.id, userId));
      await tx.delete(session).where(eq(session.userId, userId));
      await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
      await tx
        .update(oauthRefreshToken)
        .set({ revoked: new Date() })
        .where(
          and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)),
        );
      await tx.delete(oauthConsent).where(eq(oauthConsent.userId, userId));

      const message = buildJobMessage(JOB_DELETE_ACCOUNT_DATA, { user_id: userId });
      const task = await insertJobTask(tx, {
        message,
        dedupeKey: `account-delete:${userId}`,
      });
      if (task.created) return { taskId: task.id, jobId: message.job_id };
      const [existing] = await tx
        .select({ jobId: sql<string>`${externalTasks.payload}->'message'->>'job_id'` })
        .from(externalTasks)
        .where(eq(externalTasks.id, task.id));
      if (!existing?.jobId) throw new Error("Persisted deletion job ID is missing.");
      return { taskId: task.id, jobId: existing.jobId };
    });
  });
}

export async function patchAdminUserUsage(
  env: Bindings,
  userId: string,
  patch: Omit<RpcInputMap["admin.patchUsage"], "id">,
): Promise<AdminUser | null> {
  const set: Partial<{
    usedStorageBytes: number;
    usedProcessingSeconds: number;
    usedAiAnswers: number;
    usagePeriodStart: string | null;
    isOverQuota: boolean;
  }> = {};
  if (patch.used_storage_bytes !== undefined) set.usedStorageBytes = patch.used_storage_bytes;
  if (patch.used_processing_seconds !== undefined) {
    set.usedProcessingSeconds = patch.used_processing_seconds;
  }
  if (patch.used_ai_answers !== undefined) set.usedAiAnswers = patch.used_ai_answers;
  if (patch.usage_period_start !== undefined) set.usagePeriodStart = patch.usage_period_start;
  if (patch.is_over_quota !== undefined) set.isOverQuota = patch.is_over_quota;
  if (Object.keys(set).length === 0) return getAdminUser(env, userId);

  return withDb(env, async (db) => {
    const rows = await db
      .update(users)
      .set(set)
      .where(eq(users.id, userId))
      .returning(adminUserSelect);
    return rows[0] ? mapUser(rows[0]) : null;
  });
}

export function createPostgresAdminUserRepository(env:Bindings):AdminUserRepository {
  return {
    patchFlags:(_actorId,targetId,patch,headers)=>updateAdminUser(env,targetId,async tx=>{
      const auth=createAuth(env,tx);
      if(patch.is_active!==undefined){const input={body:{userId:targetId},headers};if(patch.is_active)await auth.api.unbanUser(input);else await auth.api.banUser(input);}
      if(patch.is_admin!==undefined)await auth.api.setRole({body:{userId:targetId,role:patch.is_admin?'admin':'user'},headers});
    }),
    lockForHardDelete:id=>lockUserForHardDelete(env,id),
    isAdmin:id=>isAdmin(env,id), list:(q,limit,offset)=>listAdminUsers(env,q,limit,offset),
    find:id=>getAdminUser(env,id),patchQuota:(id,patch)=>patchAdminUserQuota(env,id,patch),
    patchUsage:(id,patch)=>patchAdminUserUsage(env,id,patch),
  };
}
