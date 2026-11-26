import { expect, it } from 'vitest';
import { selectBillingSubscription, subscriptionEntitlementPatch, usableBillingPriceAmount, billingCheckoutAlreadySubscribed, billingEventOwnerMatches, type BillingSubscription, type BillingPrice } from '../src/domain/billing/subscription-policy';
const contract = (status: string, created: number, id = 'current'): BillingSubscription => ({ id, status, created, customerId: 'customer', lookupKey: 'basic_monthly' });
it('selects the contract by current entitlement, creation time, and explicit same-second tie breaking', () => {
  const current = contract('canceled', 20);
  expect(selectBillingSubscription(current, contract('canceled', 10, 'incoming'))).toBe(current);
  expect(selectBillingSubscription(current, contract('canceled', 20, 'incoming'))).toBe(current);
  const newer = contract('active', 20, 'incoming');
  expect(selectBillingSubscription(current, newer)).toBe(newer);
  const active = contract('active', 10);
  expect(selectBillingSubscription(active, contract('active', 30, 'incoming'))).toBe(active);
});
it('maps status to effective plan without touching administrator allowances', () => {
  expect(subscriptionEntitlementPatch(contract('active', 1), 'customer')).toMatchObject({ planCode: 'basic', stripeCustomerId: 'customer' });
  expect(subscriptionEntitlementPatch(contract('canceled', 1), null)).toMatchObject({ planCode: 'free', stripeCustomerId: undefined });
  expect(billingCheckoutAlreadySubscribed({ stripeSubscriptionId: 'current', planCode: 'basic', subscriptionStatus: 'active' })).toBe(true);
  expect(billingEventOwnerMatches('customer', 'other')).toBe(false);
});
it('rejects unusable provider prices, including interval and monetary representation mismatch', () => {
  const price: BillingPrice = { id: 'price', lookupKey: 'basic_monthly', active: true, recurring: true, perUnit: true, interval: 'month', intervalCount: 1, amounts: { jpy: 100 } };
  expect(usableBillingPriceAmount(price, 'basic_monthly', 'jpy')).toBe(100);
  for (const amount of [null, 0, -1, 1.5, Infinity]) expect(usableBillingPriceAmount({ ...price, amounts: { jpy: amount } }, 'basic_monthly', 'jpy')).toBeNull();
  expect(usableBillingPriceAmount(price, 'basic_yearly', 'jpy')).toBeNull();
});
