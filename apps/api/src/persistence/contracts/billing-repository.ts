import type { PlanCode, PlanEntitlements } from "../../features/billing/catalog";
export type BillingUser = {
  id: string;
  email: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  planCode: PlanCode;
  subscriptionStatus: string | null;
  /** Opaque revision for optimistic webhook writes; callers must not parse it. */
  revision: string;
};

export type BillingPatch = {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  planCode?: PlanCode;
  subscriptionStatus?: string | null;
  entitlements?: PlanEntitlements;
};

export class BillingStateChangedError extends Error {
  constructor() { super("Billing state changed during Stripe lookup; retry reconciliation."); }
}

export type BillingUpdate = { userId: string; patch: BillingPatch; expectedRevision: string };

export type BillingTarget = { userId?: string | null; customerId?: string | null; activeOnly?: boolean };
export interface BillingRepository {
  findUser(target: BillingTarget): Promise<BillingUser | null>;
  assignCustomer(userId: string, customerId: string): Promise<string | null>;
  hasEvent(eventId: string): Promise<boolean>;
  commitEvent(event: {id:string;type:string}, update: BillingUpdate | null): Promise<void>;
}
