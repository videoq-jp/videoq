import { expect, it } from 'vitest';
import { evaluationCases } from '../scripts/course-skill-evaluation/cases';
import { comparisonPlan } from '../scripts/course-skill-evaluation/plan';

it('plans every task under each condition twice with fresh blinded IDs and changing order', () => {
  const plan = comparisonPlan(evaluationCases, 'a-private-fixed-cohort-seed');
  expect(plan).toHaveLength(60);
  expect(new Set(plan.map(p => p.blindId)).size).toBe(60);
  for (const task of evaluationCases) for (const condition of ['A', 'B', 'C']) expect(plan.filter(p => p.taskId === task.id && p.condition === condition)).toHaveLength(2);
  const task = evaluationCases[0];
  const first = plan.filter(p => p.taskId === task.id && p.repetition === 1).map(p => p.condition);
  const second = plan.filter(p => p.taskId === task.id && p.repetition === 2).map(p => p.condition);
  expect(first).not.toEqual(second);
  expect(plan).toEqual(comparisonPlan(evaluationCases, 'a-private-fixed-cohort-seed'));
  expect(plan).not.toEqual(comparisonPlan(evaluationCases, 'another-private-cohort-seed'));
});
it('does not quietly accept a single-run or narrowed comparison', () => {
  expect(() => comparisonPlan(evaluationCases.slice(0, 2), 'a-private-fixed-cohort-seed')).toThrow('COMPARISON_REQUIRES_TEN_UNIQUE_TASKS');
  expect(() => comparisonPlan(evaluationCases, 'a-private-fixed-cohort-seed', 1)).toThrow('INVALID_COMPARISON_PLAN');
});
