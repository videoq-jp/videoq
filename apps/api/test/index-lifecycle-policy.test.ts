import { expect, it } from 'vitest';
import { sceneIndexAdmission, sceneIndexFinishDecision, sceneTranscriptState, sceneTranscriptRequired } from '../src/domain/search/index-lifecycle';
it('defines one lifecycle table for synchronous, staged, and durable index execution', () => {
  for (const status of ['uploading', 'pending', 'processing', 'error']) {
    expect(sceneIndexAdmission(status, true)).toBe('not_ready');
    expect(sceneIndexAdmission(status, false)).toBe('proceed');
  }
  expect(sceneIndexAdmission(undefined, true)).toBe('missing');
  expect(sceneIndexAdmission('completed', true)).toBe('completed');
  expect(sceneIndexAdmission('indexing', true)).toBe('proceed');
  expect(sceneIndexFinishDecision('pending')).toBe('pending_delivery');
  expect(sceneIndexFinishDecision('stale')).toBe('source_changed');
  expect(sceneIndexFinishDecision('missing')).toBe('build');
  expect(sceneTranscriptState(' ')).toBe('empty');
  expect(sceneTranscriptState('broken SRT')).toBe('malformed');
  expect(sceneTranscriptState('1\n00:00:00,000 --> 00:00:01,000\nLesson')).toBe('valid');
  for (const finish of [false, true]) for (const allowEmpty of [false, true]) expect(sceneTranscriptRequired(finish, allowEmpty)).toBe(finish && !allowEmpty);
});
