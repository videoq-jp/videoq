import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  normalizeStoredPlanCode,
  selectBillingEntitlement,
  billingAccountAvailable,
} from "../../application/billing-state";
import {
  billingDrizzleEntitlementChoice,
  billingDrizzleBanLogic,
} from "../billing-policy-sql";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { users, stripeEvents } from "../../db/schema/sqlite/modern";
import {
  BillingStateChangedError,
  type BillingRepository,
} from "../contracts/billing-repository";
const active = billingAccountAvailable(
  {
    banned: sql`COALESCE(${users.banned}, 0)`,
    noExpiry: sql`${users.banExpires} IS NULL`,
    expires: sql`julianday(${users.banExpires})`,
    now: sql`julianday('now')`,
  },
  billingDrizzleBanLogic,
);
export function createD1BillingRepository(
  database: D1Database,
): BillingRepository {
  const db = drizzle(database);
  return {
    async findUser(target) {
      const where = target.userId
        ? eq(users.id, target.userId)
        : target.customerId
          ? eq(users.stripeCustomerId, target.customerId)
          : null;
      if (!where) return null;
      const [row] = await db
        .select({
          id: users.id,
          email: users.email,
          stripeCustomerId: users.stripeCustomerId,
          stripeSubscriptionId: users.stripeSubscriptionId,
          planCode: users.planCode,
          subscriptionStatus: users.subscriptionStatus,
          revision: sql<string>`CAST(${users.billingRevision} AS TEXT)`,
        })
        .from(users)
        .where(and(where, target.activeOnly ? active : undefined))
        .limit(1)
        .all();
      return row
        ? { ...row, planCode: normalizeStoredPlanCode(row.planCode) }
        : null;
    },
    async assignCustomer(userId, customerId) {
      const [row] = await db
        .update(users)
        .set({
          stripeCustomerId: sql`coalesce(${users.stripeCustomerId},${customerId})`,
          updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        })
        .where(and(eq(users.id, userId), active))
        .returning({ customerId: users.stripeCustomerId })
        .all();
      return row?.customerId ?? null;
    },
    async hasEvent(id) {
      return (
        (
          await db
            .select({ id: stripeEvents.id })
            .from(stripeEvents)
            .where(eq(stripeEvents.id, id))
            .limit(1)
            .all()
        ).length > 0
      );
    },
    async commitEvent(event, update) {
      if (!update) {
        await db.insert(stripeEvents).values(event).onConflictDoNothing().run();
        return;
      }
      const { entitlements, ...patch } = update.patch;
      const quotas = entitlements
        ? {
            maxVideoUploadSizeMb: selectBillingEntitlement(
              users.quotaSource,
              sql`${entitlements.maxVideoUploadSizeMb}`,
              sql`${users.maxVideoUploadSizeMb}`,
              billingDrizzleEntitlementChoice,
            ),
            monthlyUploadLimitGb: selectBillingEntitlement(
              users.quotaSource,
              sql`${entitlements.monthlyUploadLimitGb}`,
              sql`${users.monthlyUploadLimitGb}`,
              billingDrizzleEntitlementChoice,
            ),
            storageLimitGb: selectBillingEntitlement(
              users.quotaSource,
              sql`${entitlements.storageLimitGb}`,
              sql`${users.storageLimitGb}`,
              billingDrizzleEntitlementChoice,
            ),
            processingLimitMinutes: selectBillingEntitlement(
              users.quotaSource,
              sql`${entitlements.processingLimitMinutes}`,
              sql`${users.processingLimitMinutes}`,
              billingDrizzleEntitlementChoice,
            ),
            aiAnswersLimit: selectBillingEntitlement(
              users.quotaSource,
              sql`${entitlements.aiAnswersLimit}`,
              sql`${users.aiAnswersLimit}`,
              billingDrizzleEntitlementChoice,
            ),
          }
        : {};
      const current = and(
        eq(users.id, update.userId),
        sql`CAST(${users.billingRevision} AS TEXT)=${update.expectedRevision}`,
      );
      // The conditional receipt and its effects share one atomic D1 batch. A
      // stale snapshot records nothing, so Stripe can retry reconciliation.
      const result = await runD1Batch(database, [
        db
          .insert(stripeEvents)
          .select(
            db
              .select(
                insertSelectFields(stripeEvents, {
                  id: sql`${event.id}`,
                  type: sql`${event.type}`,
                }),
              )
              .from(users)
              .where(current),
          )
          .onConflictDoNothing({ target: stripeEvents.id }),
        db
          .update(users)
          .set({
            ...patch,
            ...quotas,
            updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          })
          .where(and(sql`changes()=1`, current)),
        db
          .select({ id: stripeEvents.id })
          .from(stripeEvents)
          .where(eq(stripeEvents.id, event.id)),
      ]);
      if (!result[2].results.length) throw new BillingStateChangedError();
    },
  };
}
