import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { users, stripeEvents } from '../../db/schema/sqlite/modern';
import { BillingStateChangedError, type BillingRepository } from '../contracts/billing-repository';
const active = sql`NOT (COALESCE(${users.banned}, 0) AND (${users.banExpires} IS NULL OR julianday(${users.banExpires}) >= julianday('now')))`;
export function createD1BillingRepository(database:D1Database):BillingRepository {
  const db=drizzle(database);
  return {
    async findUser(target){
      const where=target.userId?eq(users.id,target.userId):target.customerId?eq(users.stripeCustomerId,target.customerId):null;
      if(!where)return null;
      const [row]=await db.select({id:users.id,email:users.email,stripeCustomerId:users.stripeCustomerId,stripeSubscriptionId:users.stripeSubscriptionId,
        planCode:users.planCode,subscriptionStatus:users.subscriptionStatus,revision:sql<string>`CAST(${users.billingRevision} AS TEXT)`})
        .from(users).where(and(where,target.activeOnly?active:undefined)).limit(1).all();
      return row?{...row,planCode:row.planCode==='basic'||row.planCode==='pro'?row.planCode:'free'}:null;
    },
    async assignCustomer(userId,customerId){
      const [row]=await db.update(users).set({stripeCustomerId:sql`coalesce(${users.stripeCustomerId},${customerId})`,updatedAt:sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`})
        .where(and(eq(users.id,userId),active)).returning({customerId:users.stripeCustomerId}).all();
      return row?.customerId??null;
    },
    async hasEvent(id){return (await db.select({id:stripeEvents.id}).from(stripeEvents).where(eq(stripeEvents.id,id)).limit(1).all()).length>0;},
    async commitEvent(event,update){
      if(!update){await db.insert(stripeEvents).values(event).onConflictDoNothing().run();return;}
      const values:unknown[]=[],sets=["updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
      const fields={stripeCustomerId:'stripe_customer_id',stripeSubscriptionId:'stripe_subscription_id',planCode:'plan_code',subscriptionStatus:'subscription_status'} as const;
      for(const [key,column]of Object.entries(fields)){
        const value=update.patch[key as keyof typeof fields];
        if(value!==undefined){sets.push(`${column}=?`);values.push(value);}
      }
      const entitlements=update.patch.entitlements;
      if(entitlements){
        const quotas={maxVideoUploadSizeMb:'max_video_upload_size_mb',monthlyUploadLimitGb:'monthly_upload_limit_gb',storageLimitGb:'storage_limit_gb',processingLimitMinutes:'processing_limit_minutes',aiAnswersLimit:'ai_answers_limit'} as const;
        for(const [key,column]of Object.entries(quotas)){
          sets.push(`${column}=CASE WHEN quota_source='plan' THEN ? ELSE ${column} END`);values.push(entitlements[key as keyof typeof quotas]);
        }
      }
      // The conditional receipt and its effects share one atomic D1 batch. A
      // stale snapshot records nothing, so Stripe can retry reconciliation.
      const result=await database.batch([
        database.prepare(`INSERT INTO stripe_events(id,type) SELECT ?,? WHERE EXISTS(
          SELECT 1 FROM users WHERE id=? AND CAST(billing_revision AS TEXT)=?) ON CONFLICT(id) DO NOTHING`)
          .bind(event.id,event.type,update.userId,update.expectedRevision),
        database.prepare(`UPDATE users SET ${sets.join(',')} WHERE changes()=1 AND id=? AND CAST(billing_revision AS TEXT)=?`)
          .bind(...values,update.userId,update.expectedRevision),
        database.prepare('SELECT id FROM stripe_events WHERE id=?').bind(event.id),
      ]);
      if(!result[2].results.length)throw new BillingStateChangedError();
    },
  };
}
