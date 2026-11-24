import { expect, it } from 'vitest';
import type { SceneIndexOutcome } from '../src/application/scene-index-execution';
import { sceneIndexCount, SceneIndexOutcomeError } from '../src/integrations/search-index/outcome';
import { jobFailure } from '../src/integrations/background-jobs/diagnostics';

it.each([
  [{ status: 'pending_delivery' }, 'INDEX_DELIVERY_PENDING', true],
  [{ status: 'source_changed', phase: 'finish' }, 'INDEX_SOURCE_CHANGED', true],
  [{ status: 'not_ready' }, 'INDEX_NOT_READY', true],
  [{ status: 'invalid_transcript', reason: 'empty' }, 'INVALID_TRANSCRIPT', false],
  [{ status: 'invalid_embeddings' }, 'INVALID_EMBEDDINGS', true],
] satisfies [SceneIndexOutcome, string, boolean][])('maps %j to the existing queue retry boundary', (outcome, code, retryable) => {
  let failure: unknown;
  try { sceneIndexCount(outcome); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SceneIndexOutcomeError);
  expect(jobFailure(failure, 'execute')).toEqual({ error_code: code, retryable });
});

it('retains the adapter number contract for successful work and replay no-ops', () => {
  expect(sceneIndexCount({ status: 'completed', sceneCount: 2 })).toBe(2);
  expect(sceneIndexCount({ status: 'skipped', reason: 'already_completed' })).toBe(0);
  expect(sceneIndexCount({ status: 'skipped', reason: 'missing_source' })).toBe(0);
});
