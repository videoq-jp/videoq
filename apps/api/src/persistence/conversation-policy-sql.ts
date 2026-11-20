/** Operands are closed SQL expressions and placeholders supplied by adapters. */
export const conversationStringLogic = {
  atLeast: (value: string, minimum: number) => `${value} >= ${minimum}`,
  equal: (left: string, right: string) => `${left}=${right}`,
  and: (left: string, right: string) => `(${left} AND ${right})`,
  or: (left: string, right: string) => `(${left} OR ${right})`,
  empty: (value: string) => `${value} = ''`,
  choose: (condition: string, yes: string, no: string) => `CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`,
};
