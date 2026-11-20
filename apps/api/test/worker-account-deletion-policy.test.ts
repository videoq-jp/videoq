import { expect, it } from 'vitest';
import { accountDeletionDrainOutcome, accountDeletionForbidden, accountDeletionVideoOutcome } from '../src/application/worker-account-deletion';
const logic = { or: (...terms: boolean[]) => terms.some(Boolean), not: (term: boolean) => !term };

it('requires a permanent ban and refuses administrators for an existing user', () => {
  expect(accountDeletionForbidden({ banned: true, noExpiry: true, administrator: false }, logic)).toBe(false);
  expect(accountDeletionForbidden({ banned: false, noExpiry: true, administrator: false }, logic)).toBe(true);
  expect(accountDeletionForbidden({ banned: true, noExpiry: false, administrator: false }, logic)).toBe(true);
  expect(accountDeletionForbidden({ banned: true, noExpiry: true, administrator: true }, logic)).toBe(true);
});
it('requires the deletion fence at each step and only completes after the root is absent', () => {
  expect(accountDeletionVideoOutcome(false)).toEqual({ status: 'denied' });
  expect(accountDeletionVideoOutcome(true)).toEqual({ status: 'progress' });
  expect(accountDeletionDrainOutcome(false, false)).toEqual({ status: 'denied' });
  expect(accountDeletionDrainOutcome(true, true)).toEqual({ status: 'progress' });
  expect(accountDeletionDrainOutcome(true, false)).toEqual({ status: 'completed' });
});
