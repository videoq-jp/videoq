import { expect, it } from 'vitest';
import { AnswerAgentBudget, MAX_TOOL_ROUNDS, hasAgentContext } from '../src/application/agent-execution';

it('bounds all model tool attempts and keeps the terminal model calls tool-free', () => {
  const budget = new AnswerAgentBudget();
  for (let call = 0; call < MAX_TOOL_ROUNDS; call++) expect(budget.allowToolsForNextModelCall()).toBe(true);
  for (let call = 0; call < 3; call++) expect(budget.allowToolsForNextModelCall()).toBe(false);
});

it('keeps independent answers from sharing or inheriting the exhausted round budget', () => {
  const first = new AnswerAgentBudget();
  for (let call = 0; call <= MAX_TOOL_ROUNDS; call++) first.allowToolsForNextModelCall();
  expect(first.allowToolsForNextModelCall()).toBe(false);
  expect(new AnswerAgentBudget().allowToolsForNextModelCall()).toBe(true);
});

it.each([
  { scope: { videoIds: null }, available: false },
  { scope: { videoIds: [] }, available: false },
  { scope: { courseId: null, videoIds: [] }, available: false },
  { scope: { courseId: 3, videoIds: [] }, available: true },
  { scope: { courseId: 3, videoIds: null }, available: true },
  { scope: { videoIds: [42] }, available: true },
])('selects evidence capabilities for the authorized scope $scope', ({ scope, available }) => {
  expect(hasAgentContext(scope)).toBe(available);
});
