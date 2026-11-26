import { isPaidPlan, isUsableSubscriptionStatus, planCodeFromLookupKey, PLAN_CATALOG, type BillingCurrency } from './billing-catalog';

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

export function usableBillingPriceAmount(price: BillingPrice, lookupKey: string, currency: BillingCurrency): number | null {
  const amount = price.amounts[currency];
  const interval = lookupKey.endsWith('_yearly') ? 'year' : 'month';
  return price.active && price.recurring && price.interval === interval && price.intervalCount === 1 && price.perUnit
    && amount != null && Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
export function billingCheckoutAlreadySubscribed(user: { stripeSubscriptionId: string | null; planCode: string; subscriptionStatus: string | null }): boolean {
  return Boolean(user.stripeSubscriptionId && isPaidPlan(user.planCode) && isUsableSubscriptionStatus(user.subscriptionStatus));
}
export function billingEventOwnerMatches(storedCustomer: string | null, eventCustomer: string | null): boolean {
  return !storedCustomer || eventCustomer === storedCustomer;
}
export function billingSubscriptionCustomerMatches(subscription: BillingSubscription, customerId: string | null): boolean {
  return subscription.customerId === customerId;
}
/** Contract creation and current entitlement win over delivery ordering. */
export function selectBillingSubscription(current: BillingSubscription, incoming: BillingSubscription): BillingSubscription {
  return isUsableSubscriptionStatus(current.status) || current.created > incoming.created
    || (current.created === incoming.created && !isUsableSubscriptionStatus(incoming.status)) ? current : incoming;
}
export function subscriptionEntitlementPatch(subscription: BillingSubscription, customerId: string | null) {
  const plan = subscription.lookupKey ? planCodeFromLookupKey(subscription.lookupKey) ?? 'free' : 'free';
  const effectivePlan = isUsableSubscriptionStatus(subscription.status) ? plan : 'free';
  return { stripeCustomerId: customerId ?? undefined, stripeSubscriptionId: subscription.id,
    planCode: effectivePlan, subscriptionStatus: subscription.status, entitlements: PLAN_CATALOG[effectivePlan].entitlements };
}
