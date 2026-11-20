import type { ResourceErrorChoice } from '../application/resource-mutation';

/** Predicates are adapter-owned SQL; codes are a closed application union. */
export const resourceSqlErrorChoice: ResourceErrorChoice<string, string> = {
  code: code => `'${code}'`,
  when: (predicate, yes, no) => `CASE WHEN (${predicate}) THEN ${yes} ELSE ${no} END`,
};
