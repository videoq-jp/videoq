import type { QaLogic } from "../features/qa/policy";

/** Operands are SQL predicates produced by the adapter, never raw user input. */
export const qaSqlLogic: QaLogic<string> = {
  and: (left, right) => `(${left} AND ${right})`,
  or: (left, right) => `(${left} OR ${right})`,
  not: value => `(NOT (${value}))`,
};
