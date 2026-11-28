import { createHash } from 'node:crypto';
import type { EvaluationCase } from './cases';

export type ComparisonCondition = 'A' | 'B' | 'C';
export function comparisonPlan(cases: readonly EvaluationCase[], seed: string, repetitions = 2) {
  if (seed.length < 16 || !Number.isSafeInteger(repetitions) || repetitions < 2 || repetitions > 5) throw new Error('INVALID_COMPARISON_PLAN');
  if (cases.length < 10 || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('COMPARISON_REQUIRES_TEN_UNIQUE_TASKS');
  const hash = (text: string) => createHash('sha256').update(`${seed}:${text}`).digest('hex');
  const conditions: ComparisonCondition[] = ['A', 'B', 'C'];
  const plan: { taskId: string; repetition: number; condition: ComparisonCondition; blindId: string }[] = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const order = cases.map((task, index) => ({ task, index, rank: hash(`order:${repetition}:${task.id}`) })).sort((a, b) => a.rank.localeCompare(b.rank));
    for (const { task, index } of order) for (let step = 0; step < conditions.length; step++) {
      const condition = conditions[(index + repetition + step) % conditions.length];
      plan.push({ taskId: task.id, repetition: repetition + 1, condition, blindId: hash(`blind:${task.id}:${repetition}:${condition}`).slice(0, 24) });
    }
  }
  return plan;
}
