import type { PairingLogic } from '../application/pairing-exchange';
export type PairingPredicate = { sql: string; values: unknown[] };

export const pairingSqlLogic: PairingLogic<string, PairingPredicate> = {
  modeIsNot: (mode, expected) => ({ sql: `?<> '${expected}'`, values: [mode] }),
  and: (...terms) => ({ sql: terms.map(term => `(${term.sql})`).join(' AND '), values: terms.flatMap(term => term.values) }),
  or: (left, right) => ({ sql: `(${left.sql} OR ${right.sql})`, values: [...left.values, ...right.values] }),
  not: term => ({ sql: `NOT (${term.sql})`, values: term.values }),
};
