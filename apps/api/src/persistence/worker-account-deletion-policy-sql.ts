import type { AccountDeletionLogic } from '../application/worker-account-deletion';

export const accountDeletionStringLogic: AccountDeletionLogic<string> = {
  or: (...terms) => `(${terms.map(term => `(${term})`).join(' OR ')})`,
  not: term => `NOT (${term})`,
};
