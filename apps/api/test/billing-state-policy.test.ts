import { expect, it } from 'vitest';
import {
  normalizeStoredPlanCode, selectBillingEntitlement, billingAccountAvailable,
  type BillingBanLogic, type BillingEntitlementChoice,
} from '../src/domain/billing/billing-state';

it.each([
  { stored: 'free', expected: 'free' }, { stored: 'basic', expected: 'basic' }, { stored: 'pro', expected: 'pro' },
  { stored: 'legacy', expected: 'free' }, { stored: 'PRO', expected: 'free' }, { stored: '', expected: 'free' },
])('normalizes stored plan $stored without inventing a paid plan', ({ stored, expected }) => {
  expect(normalizeStoredPlanCode(stored)).toBe(expected);
});

const choices: BillingEntitlementChoice<string | null, number | null, boolean> = {
  sourceEquals: (source, expected) => source === expected,
  choose: (predicate, yes, no) => predicate ? yes : no,
};
it.each(['admin', 'onprem', 'legacy', null])('retains current quotas from source %s, including unlimited overrides', source => {
  expect(selectBillingEntitlement(source, 2000, 17, choices)).toBe(17);
  expect(selectBillingEntitlement(source, 2000, null, choices)).toBeNull();
});
it('applies plan entitlements including a hard zero only to the plan source', () => {
  expect(selectBillingEntitlement('plan', 2000, 17, choices)).toBe(2000);
  expect(selectBillingEntitlement('plan', 0, null, choices)).toBe(0);
});

type Truth = boolean | null;
const banLogic: BillingBanLogic<number | null, Truth> = {
  and: (left, right) => left === false || right === false ? false : left === null || right === null ? null : true,
  or: (left, right) => left === true || right === true ? true : left === null || right === null ? null : false,
  not: value => value === null ? null : !value,
  atOrAfter: (expires, now) => expires === null || now === null ? null : expires >= now,
};
it.each([
  { label: 'unbanned without expiry', banned: false, noExpiry: true, expires: null, expected: true },
  { label: 'unbanned with invalid expiry', banned: false, noExpiry: false, expires: null, expected: true },
  { label: 'indefinite ban', banned: true, noExpiry: true, expires: null, expected: false },
  { label: 'future ban', banned: true, noExpiry: false, expires: 1001, expected: false },
  { label: 'expiry equals current clock', banned: true, noExpiry: false, expires: 1000, expected: false },
  { label: 'expired ban', banned: true, noExpiry: false, expires: 999, expected: true },
  { label: 'unknown comparison on malformed expiry', banned: true, noExpiry: false, expires: null, expected: null },
])('keeps billing admission for $label', ({ expected, ...facts }) => {
  expect(billingAccountAvailable({ ...facts, now: 1000 }, banLogic)).toBe(expected);
});
