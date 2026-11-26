import type { SkillFact } from './model';

// A request-sized budget, never a course-sized budget. Each saved cursor moves
// through every fact; larger inputs produce more resumable steps.
export const SKILL_FACT_BATCH_CHARS = 24_000;
export function nextFactBatch(facts: SkillFact[], offset: number): SkillFact[] {
  let size = 0;
  const batch: SkillFact[] = [];
  for (let index = offset; index < facts.length && batch.length < 80; index++) {
    const fact = facts[index], length = JSON.stringify(fact).length;
    if (batch.length && size + length > SKILL_FACT_BATCH_CHARS) break;
    batch.push(fact); size += length;
  }
  return batch;
}
