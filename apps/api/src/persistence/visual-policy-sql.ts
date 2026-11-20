import type { VisualLogic } from '../application/visual-checkpoint-policy';

/** Expressions are adapter-owned. Request values always remain bound. */
export const visualStringLogic: VisualLogic<string> = {
  and: (...terms) => `(${terms.map(term => `(${term})`).join(' AND ')})`,
  or: (...terms) => `(${terms.map(term => `(${term})`).join(' OR ')})`,
  not: term => `NOT (${term})`,
};
