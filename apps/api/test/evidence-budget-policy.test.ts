import { expect, it } from 'vitest';
import { EvidenceBudget } from '../src/domain/conversation/evidence-budget';
it('reserves shared images before I/O, settles once, and limits concurrent inspections', () => {
  const budget = new EvidenceBudget();
  const a = budget.reserveVisual('overview')!, b = budget.reserveVisual('overview')!, c = budget.reserveVisual('focus')!;
  expect(budget.remaining().remaining_images).toBe(0);
  expect(budget.reserveVisual('inspect')).toBeNull();
  a.settle(8); a.settle(0);
  expect(budget.remaining().remaining_images).toBe(8);
  const d = budget.reserveVisual('inspect')!;
  expect(d.maxFrames).toBe(8);
  b.settle(0); c.settle(0); d.settle(0);
  expect(budget.reserveVisual('inspect')).toBeNull();
  expect(budget.remaining().remaining_images).toBe(40);
});
it('keeps retries from consuming another tool slot and enforces per-tool limits', () => {
  const budget = new EvidenceBudget();
  expect(budget.reserveTool('focus', 'first')).toBe('accepted');
  expect(budget.reserveTool('focus', 'first')).toBe('duplicate');
  expect(budget.reserveTool('focus', 'second')).toBe('accepted');
  expect(budget.reserveTool('focus', 'third')).toBe('limit');
  expect(budget.remaining().remaining_focus_calls).toBe(0);
});
