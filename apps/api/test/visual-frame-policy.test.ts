import { expect, it } from 'vitest';
import { assertFocusInterval, selectClipFrames, selectDenseFramePlan } from '../src/domain/conversation/video-evidence';

it('keeps sparse window endpoints and time-distributed samples without mutating source frames', () => {
  const frames = Array.from({ length: 21 }, (_, index) => ({ timestamp_seconds: index, opaque: String(index) }));
  const selected = selectClipFrames(frames, 2, 18, 8);
  expect(selected).toHaveLength(8);
  expect(selected[0]).toBe(frames[2]); expect(selected.at(-1)).toBe(frames[18]);
  expect(new Set(selected).size).toBe(8); expect(frames).toHaveLength(21);
  expect(selectClipFrames(frames, 2.1, 2.9)).toEqual([]);
  expect(selectClipFrames(frames, 2, 18, 0)).toEqual([]);
});

it('keeps exactly sixteen dense samples for [0,16), excluding the endpoint', () => {
  const frames = Array.from({ length: 17 }, (_, time) => ({ time, id: 'frame-' + time }));
  expect(selectDenseFramePlan(frames, frame => frame.time, 0, 16, 16)).toEqual({ frames: frames.slice(0, 16) });
});

it('rejects a dense interval that exceeds the remaining or absolute image budget instead of resampling', () => {
  const frames = Array.from({ length: 17 }, (_, time) => time);
  expect(selectDenseFramePlan(frames, time => time, 0, 16, 8)).toHaveProperty('unavailable', expect.stringContaining('budget'));
  expect(selectDenseFramePlan(frames, time => time, 0, 17, 100)).toHaveProperty('unavailable', expect.stringContaining('budget'));
});

it('retains empty source gaps before applying the remaining image budget', () => {
  for (const budget of [-1, 0, 16]) expect(selectDenseFramePlan([1, 9], time => time, 2, 8, budget)).toEqual({ frames: [] });
});

it('accepts fractional endpoints with the same half-open units as the stored frame index', () => {
  expect(selectDenseFramePlan([1000, 1250, 1500, 1750], time => time, 1250, 1750, 16)).toEqual({ frames: [1250, 1500] });
  expect(() => assertFocusInterval(0.125, 16.125)).not.toThrow();
});

it.each([
  { start: -1, end: 1 }, { start: 0, end: 0 }, { start: 2, end: 1 },
  { start: 0, end: 16.001 }, { start: Number.NaN, end: 1 }, { start: 0, end: Infinity },
])('rejects invalid focus interval $start to $end', ({ start, end }) => {
  expect(() => assertFocusInterval(start, end)).toThrow('Focus requires a positive interval of at most 16 seconds');
});
