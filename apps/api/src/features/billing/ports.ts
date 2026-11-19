import type { BillingCurrency, PaidLookupKey } from './catalog';

/** Provider snapshots contain only facts required by billing policy. */
export type BillingPrice = {
  id: string;
  lookupKey: string | null;
  active: boolean;
  recurring: boolean;
  perUnit: boolean;
  interval: string | null;
  intervalCount: number | null;
  amounts: Partial<Record<BillingCurrency, number | null>>;
};
export type BillingSubscription = { id: string; customerId: string | null; status: string; created: number; lookupKey?: string | null };
export type BillingEventTarget = { userId?: string | null; customerId: string | null; subscriptionId: string };
export type BillingEvent = { id: string; type: string; target?: BillingEventTarget };
export type CheckoutRequest = {
  customerId: string; userId: string; priceId: string; lookupKey: PaidLookupKey; currency: BillingCurrency; locale?: string;
};
export interface BillingGateway {
  configured: boolean;
  listPrices(lookupKeys: readonly string[], limit?: number): Promise<BillingPrice[]>;
  createCustomer(email: string, userId: string): Promise<string>;
  createCheckout(input: CheckoutRequest): Promise<string | null>;
  createPortal(customerId: string, locale?: string): Promise<string>;
  retrieveSubscription(id: string): Promise<BillingSubscription>;
}
