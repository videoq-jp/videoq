import { expect, it } from 'vitest';
import { sampleByTimeGroups } from '../src/domain/conversation/video-evidence';

it('keeps a short later demonstration covered despite a long earlier explanation', () => {
  const frames = Array.from({ length: 121 }, (_, time) => ({ time }));
  const groups = [[{ start: 0, end: 90 }], [{ start: 100, end: 110 }]];
  const selected = sampleByTimeGroups(frames, f => f.time, groups, 4);
  expect(selected).toHaveLength(4);
  expect(selected.filter(f => f.time >= 100 && f.time <= 110)).toHaveLength(2);
  expect(selected.some(f => f.time > 100 && f.time < 110)).toBe(true);
  expect(selected.every(f => f.time <= 90 || (f.time >= 100 && f.time <= 110))).toBe(true);
});

it('shares overlapping frames without duplicates and excludes gaps and unavailable groups', () => {
  const frames = Array.from({ length: 30 }, (_, time) => ({ time }));
  const selected = sampleByTimeGroups(frames, f => f.time, [[{ start: 0, end: 3 }, { start: 20, end: 23 }], [{ start: 20, end: 23 }], [{ start: 100, end: 110 }]], 8);
  expect(selected).toHaveLength(8);
  expect(new Set(selected).size).toBe(8);
  expect(selected.every(f => f.time <= 3 || (f.time >= 20 && f.time <= 23))).toBe(true);
  expect(sampleByTimeGroups(frames, f => f.time, [[{ start: 100, end: 110 }]], 8)).toEqual([]);
  expect(sampleByTimeGroups(frames, f => f.time, [[{ start: 0, end: 29 }]], 0)).toEqual([]);
});
