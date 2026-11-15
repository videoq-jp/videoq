import { and, eq, sql } from "drizzle-orm";
import { withDb, type Db } from "../../db/pool";
import { stripeEvents, users } from "../../db/schema";
import type { PlanCode } from "../../features/billing/catalog";
import type { Bindings } from "../../types/bindings";

import { BillingStateChangedError, type BillingUser, type BillingPatch, type BillingUpdate, type BillingRepository } from "../contracts/billing-repository";
function asPlanCode(value: string): PlanCode {
  if (value === "basic" || value === "pro" || value === "free") return value;
  return "free";
}

export async function getBillingUser(
  env: Bindings,
  userId: string,
): Promise<BillingUser | null> {
  return findBillingUser(env, { userId, activeOnly: true });
}

const activeBillingUser = sql`NOT (COALESCE(${users.banned}, false)
  AND (${users.banExpires} IS NULL OR ${users.banExpires} >= now()))`;

export async function findBillingUser(
  env: Bindings,
  target: { userId?: string | null; customerId?: string | null; activeOnly?: boolean },
): Promise<BillingUser | null> {
  const where = target.userId
    ? eq(users.id, target.userId)
    : target.customerId ? eq(users.stripeCustomerId, target.customerId) : null;
  if (!where) return null;
  return withDb(env, async (db) => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        stripeCustomerId: users.stripeCustomerId,
        stripeSubscriptionId: users.stripeSubscriptionId,
        planCode: users.planCode,
        subscriptionStatus: users.subscriptionStatus,
        revision: sql<string>`${users.updatedAt}::text`,
      })
      .from(users)
      .where(and(where, target.activeOnly ? activeBillingUser : undefined))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      stripeCustomerId: row.stripeCustomerId,
      stripeSubscriptionId: row.stripeSubscriptionId,
      planCode: asPlanCode(row.planCode),
      subscriptionStatus: row.subscriptionStatus,
      revision: row.revision,
    };
  });
}

async function updateBillingState(
  db: Pick<Db, "update">,
  userId: string,
  patch: BillingPatch,
  expectedRevision: string,
): Promise<void> {
  const { entitlements, ...fields } = patch;
  const updated = await db.update(users).set({
    ...fields,
    updatedAt: sql`clock_timestamp()`,
    // Evaluate the current quota source while updating, not before Stripe I/O.
    ...(entitlements ? {
      maxVideoUploadSizeMb: sql`CASE WHEN ${users.quotaSource} = 'plan' THEN ${entitlements.maxVideoUploadSizeMb} ELSE ${users.maxVideoUploadSizeMb} END`,
      monthlyUploadLimitGb: sql`CASE WHEN ${users.quotaSource} = 'plan' THEN ${entitlements.monthlyUploadLimitGb} ELSE ${users.monthlyUploadLimitGb} END`,
      storageLimitGb: sql`CASE WHEN ${users.quotaSource} = 'plan' THEN ${entitlements.storageLimitGb} ELSE ${users.storageLimitGb} END`,
      processingLimitMinutes: sql`CASE WHEN ${users.quotaSource} = 'plan' THEN ${entitlements.processingLimitMinutes} ELSE ${users.processingLimitMinutes} END`,
      aiAnswersLimit: sql`CASE WHEN ${users.quotaSource} = 'plan' THEN ${entitlements.aiAnswersLimit} ELSE ${users.aiAnswersLimit} END`,
    } : {}),
  }).where(and(
    eq(users.id, userId),
    sql`${users.updatedAt} = ${expectedRevision}::timestamptz`,
  )).returning({ id: users.id });
  if (updated.length === 0) throw new BillingStateChangedError();
}

/** Concurrent first checkouts must use the same customer once one wins. */
export async function assignBillingCustomer(
  env: Bindings,
  userId: string,
  customerId: string,
): Promise<string | null> {
  return withDb(env, async (db) => {
    // The account-deletion transaction bans and locks this same row. A checkout
    // which started earlier must not attach a new customer after that lock.
    const rows = await db.update(users).set({
      stripeCustomerId: sql`coalesce(${users.stripeCustomerId}, ${customerId})`,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(users.id, userId), activeBillingUser)).returning({ customerId: users.stripeCustomerId });
    return rows[0]?.customerId ?? null;
  });
}

export async function hasProcessedStripeEvent(
  env: Bindings,
  eventId: string,
): Promise<boolean> {
  return withDb(env, async (db) => {
    const rows = await db.select({ id: stripeEvents.id }).from(stripeEvents)
      .where(eq(stripeEvents.id, eventId)).limit(1);
    return rows.length > 0;
  });
}

/** A receipt is committed only together with its effects; concurrent duplicates wait here. */
export async function commitStripeEvent(
  env: Bindings,
  event: { id: string; type: string },
  update: BillingUpdate | null,
): Promise<void> {
  return withDb(env, (db) => db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing({ target: stripeEvents.id })
      .returning({ id: stripeEvents.id });
    if (inserted.length > 0 && update) {
      await updateBillingState(tx, update.userId, update.patch, update.expectedRevision);
    }
  }));
}

export function createPostgresBillingRepository(env: Bindings): BillingRepository {
  return {
    findUser: target => findBillingUser(env,target),
    assignCustomer: (userId,customerId) => assignBillingCustomer(env,userId,customerId),
    hasEvent: id => hasProcessedStripeEvent(env,id),
    commitEvent: (event,update) => commitStripeEvent(env,event,update),
  };
}
