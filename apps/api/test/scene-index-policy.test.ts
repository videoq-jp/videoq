import { expect, it } from 'vitest';
import {
  canonicalSceneVectorInput, sceneFinishAllowed, sceneIndexCompletionOutcome, scenePublishAllowed, sceneRunCurrent,
  sceneStageAllowed, validateSceneEmbedding, validateSceneIndexRun, type SceneEmbedding,
} from '../src/domain/search/scene-index-policy';

const scene = (embedding = Array<number>(768).fill(0.25)): SceneEmbedding => ({
  id: 'scene', content: '本文', startTime: '00:01', endTime: '00:02', embedding,
});
const logic = { and: (...terms: boolean[]) => terms.every(Boolean) };

it('permits empty index runs but bounds run identity, dimensions and expected count', () => {
  const input = { runId: 'run', dimensions: 768, expectedScenes: 0 };
  expect(() => validateSceneIndexRun(input)).not.toThrow();
  for (const change of [{ runId: '' }, { runId: 'x'.repeat(129) }, { dimensions: 3 }, { expectedScenes: -1 }, { expectedScenes: 0.5 }]) {
    expect(() => validateSceneIndexRun({ ...input, ...change })).toThrow('Invalid scene index run');
  }
});
it('rejects zero, underflowing, overflowing and non-finite float32 embeddings', () => {
  const physical = { idFits: true, duplicate: false };
  expect(() => validateSceneEmbedding(scene(), 768, physical)).not.toThrow();
  for (const value of [0, 1e-50, 1e40, Infinity, NaN]) {
    expect(() => validateSceneEmbedding(scene(Array<number>(768).fill(value)), 768, physical)).toThrow('Invalid scene embedding');
  }
  expect(() => validateSceneEmbedding(scene([1]), 768, physical)).toThrow();
  expect(() => validateSceneEmbedding(scene(), 768, { ...physical, duplicate: true })).toThrow();
  expect(() => validateSceneEmbedding(scene(), 768, { ...physical, idFits: false })).toThrow();
});
it('keeps vector identity byte-compatible and distinguishes original numbers before float32 rounding', () => {
  const input = scene([0.25, -0]);
  expect(canonicalSceneVectorInput('run', input)).toBe('["run","scene","本文","00:01","00:02","transcript",[0.25,0]]');
  expect(canonicalSceneVectorInput('run', { ...input, evidenceType: 'transcript' })).toBe(canonicalSceneVectorInput('run', input));
  expect(canonicalSceneVectorInput('run', { ...input, evidenceType: 'visual' })).not.toBe(canonicalSceneVectorInput('run', input));
  const original = 0.250000001;
  expect(Math.fround(original)).toBe(0.25);
  expect(canonicalSceneVectorInput('run', scene([original]))).not.toBe(canonicalSceneVectorInput('run', scene([0.25])));
});
it('requires the current source and dimension head at staging and complete publication', () => {
  expect(sceneRunCurrent({ owner: true, source: true, head: false }, logic)).toBe(false);
  expect(sceneStageAllowed(true, false, logic)).toBe(false);
  expect(scenePublishAllowed(true, true, false, logic)).toBe(false);
  expect(scenePublishAllowed(true, true, true, logic)).toBe(true);
});
it('keeps indexing pending until the published current source is ANN-visible', () => {
  expect(sceneFinishAllowed(true, true, false, logic)).toBe(false);
  expect(sceneFinishAllowed(true, false, true, logic)).toBe(false);
  expect(sceneFinishAllowed(false, true, true, logic)).toBe(false);
  expect(sceneFinishAllowed(true, true, true, logic)).toBe(true);
  expect(sceneIndexCompletionOutcome({ status: 'indexing', published: true })).toBe('pending');
  expect(sceneIndexCompletionOutcome({ status: 'indexing', published: false })).toBe('missing');
  expect(sceneIndexCompletionOutcome({ status: 'completed', published: false })).toBe('completed');
  expect(sceneIndexCompletionOutcome({ status: 'error', published: true })).toBe('stale');
  expect(sceneIndexCompletionOutcome(undefined)).toBe('stale');
});
