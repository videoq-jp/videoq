import { expect, it } from 'vitest';
import {
  validateVisualCheckpoint, visualAttemptAdoptable, visualAttemptAllowed, visualObjectAttempt,
  visualObjectDesired, visualPlan, visualReadyAllowed, visualRunRecoveryAllowed, type VisualLogic,
} from '../src/application/visual-checkpoint-policy';
const logic: VisualLogic<boolean> = {
  and: (...terms) => terms.every(Boolean), or: (...terms) => terms.some(Boolean), not: term => !term,
};
const version = '00000000-0000-0000-0000-000000000001';

it('keeps a partial last chunk and caps the visual plan at ten hours', () => {
  expect(visualPlan(60001)).toEqual({ count: 2 });
  expect(visualPlan(36_000_000)).toEqual({ count: 600 });
  for (const duration of [0, -1, 1.1, NaN, Infinity, 36_000_001]) {
    expect(() => visualPlan(duration)).toThrow('Invalid visual duration');
  }
});
it('permits empty chunks while bounding frame count and immutable attempt identity', () => {
  expect(() => validateVisualCheckpoint(0, version)).not.toThrow();
  expect(() => validateVisualCheckpoint(60, version)).not.toThrow();
  for (const count of [-1, 61, 1.5, NaN]) expect(() => validateVisualCheckpoint(count, version)).toThrow();
  expect(visualObjectAttempt(version)).toEqual({ id: `m:${version}`, kind: 'manifest' });
  expect(visualObjectAttempt(version, 599)).toEqual({ id: `c:${version}`, kind: 'chunk' });
  expect(() => visualObjectAttempt(version, 600)).toThrow('Invalid visual object attempt');
  expect(() => visualObjectAttempt('not-a-version')).toThrow();
});
it('stops writes after ready and fences a requested chunk that already has a result', () => {
  expect(visualAttemptAllowed(false, false, true, logic)).toBe(false);
  expect(visualAttemptAllowed(true, true, false, logic)).toBe(false);
  expect(visualAttemptAllowed(true, false, false, logic)).toBe(true);
});
it('requires all versioned chunks and at least one frame before ready', () => {
  const facts = { current: true, adoptableAttempt: true, complete: true, hasFrames: true };
  expect(visualReadyAllowed(facts, logic)).toBe(true);
  for (const key of Object.keys(facts)) expect(visualReadyAllowed({ ...facts, [key]: false }, logic)).toBe(false);
});
it('replays adopted manifests after expiry but never adopts an expired pending attempt', () => {
  expect(visualAttemptAdoptable(true, false, false, logic)).toBe(true);
  expect(visualAttemptAdoptable(false, true, false, logic)).toBe(false);
  expect(visualAttemptAdoptable(false, true, true, logic)).toBe(true);
});
it('recovers a failed run only after every chunk error is cleared and this chunk won', () => {
  const facts = { notReady: true, noChunkErrors: true, winningChunk: true, current: true };
  expect(visualRunRecoveryAllowed(facts, logic)).toBe(true);
  for (const key of Object.keys(facts)) expect(visualRunRecoveryAllowed({ ...facts, [key]: false }, logic)).toBe(false);
});
it('protects winning chunks before ready and only the adopted manifest after ready', () => {
  const facts = { current: true, manifest: false, ready: false, winningManifest: false, chunk: true, winningChunk: true };
  expect(visualObjectDesired(facts, logic)).toBe(true);
  expect(visualObjectDesired({ ...facts, current: false }, logic)).toBe(false);
  expect(visualObjectDesired({ ...facts, chunk: false, manifest: true, ready: true, winningManifest: true }, logic)).toBe(true);
  expect(visualObjectDesired({ ...facts, chunk: false, manifest: true, ready: true }, logic)).toBe(false);
});
