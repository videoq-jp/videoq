import { describe, expect, it } from 'vitest';
import { materialMutationKind, planMaterialMutation, assertMaterialGeneration, assertMaterialReferences,
  assertMaterialReadable, assertMaterialReplayIdentity, assertMaterialOperationAvailable, assertMaterialRevision } from '../src/application/material-mutation';
import type { MaterialCommand, ReadableManagedVideo, MaterialTranscriptionMessage } from '../src/application/material-management';

const video: ReadableManagedVideo = { title: 'Canonical', file: 'canonical.mp4', status: 'completed', description: 'notes', transcript: 'caption' };
const command = (action: 'reindex' | 'retry'): Exclude<MaterialCommand, { action: 'get' }> =>
  ({ action, videoId: 7, operationId: 'operation', revision: 'revision' });
const update = (fields: { description?: string; transcript?: string }): Exclude<MaterialCommand, { action: 'get' }> =>
  ({ action: 'update', videoId: 7, operationId: 'operation', revision: 'revision', fields });

it('changes only derived teaching text and retains unmodelled snapshot fields', () => {
  const current = { ...video, sourceRevision: 'physical-revision' };
  const plan = planMaterialMutation(update({ description: '', transcript: video.transcript }), current);
  expect(plan).toEqual({ next: { ...current, description: '' }, transcriptChanged: false, indexChanged: false });
  expect(current).toEqual({ ...video, sourceRevision: 'physical-revision' });
});

it.each(['completed', 'error'])('indexes changed transcripts from %s without changing canonical source identity', status => {
  const plan = planMaterialMutation(update({ transcript: 'edited' }), { ...video, status });
  expect(plan).toEqual({ next: { ...video, transcript: 'edited', status: 'indexing' }, transcriptChanged: true,
    indexChanged: true, job: { kind: 'index', payload: { video_id: 7 } } });
});

it.each(['', ' \n\t'])('explicitly allows empty or whitespace-only indexing content', transcript => {
  expect(planMaterialMutation(update({ transcript }), video).job).toEqual({ kind: 'index', payload: { video_id: 7, allow_empty: true } });
  expect(planMaterialMutation(command('reindex'), { ...video, transcript }).job).toEqual({ kind: 'index', payload: { video_id: 7, allow_empty: true } });
});

it('retries stalled indexing without needing a transcription envelope', () => {
  const plan = planMaterialMutation(command('retry'), { ...video, status: 'indexing' });
  expect(plan).toMatchObject({ next: { status: 'indexing' }, indexChanged: true, transcriptChanged: false,
    job: { kind: 'index', payload: { video_id: 7 } } });
});

it.each([null, 'failed', 'running'])('preserves original retry identity for worker state %s', retryStatus => {
  const original: MaterialTranscriptionMessage = { type: 'transcribe_video', job_id: 'original-worker', payload: { video_id: 7 } };
  const plan = planMaterialMutation(command('retry'), { ...video, status: 'error' }, original, retryStatus);
  expect(plan).toEqual({ next: { ...video, status: 'pending' }, transcriptChanged: false, indexChanged: false,
    job: { kind: 'retry', message: original } });
  if (plan.job?.kind === 'retry') expect(plan.job.message).toBe(original);
});

it('refuses missing, mismatched or already-completed retry identities', () => {
  const original: MaterialTranscriptionMessage = { type: 'transcribe_video', job_id: 'original-worker', payload: { video_id: 7 } };
  const current = { ...video, status: 'error' };
  for (const [message, status] of [[undefined, null], [{ ...original, payload: { video_id: 8 } }, null], [original, 'completed']] as const)
    expect(() => planMaterialMutation(command('retry'), current, message, status)).toThrow('Retry synchronization from Moodle');
});

describe('mutation admission before backend constraints and retry lookup', () => {
  it.each(['indexing', 'pending', 'processing'])('refuses edits while %s', status => {
    expect(() => materialMutationKind(update({ transcript: 'changed' }), status)).toThrow('Wait for processing before editing');
  });
  it.each(['error', 'indexing', 'pending'])('refuses explicit reindex while %s', status => {
    expect(() => materialMutationKind(command('reindex'), status)).toThrow('Wait for processing before starting a new index');
  });
  it.each(['completed', 'pending', 'processing'])('refuses an unnecessary transcription retry while %s', status => {
    expect(() => materialMutationKind(command('retry'), status)).toThrow('does not need a processing retry');
  });
});

it('keeps staged generation, reference, content and operation failures distinct', () => {
  expect(() => assertMaterialGeneration(2, 1)).toThrow('Moodle source has changed');
  for (const [count, course, bindings] of [[0, NaN, 1], [2, 9, 1], [1, 8, 1], [1, 9, 2]])
    expect(() => assertMaterialReferences(count, course, bindings, 9)).toThrow('referenced outside this course');
  expect(() => assertMaterialReferences(1, 9, 1, 9)).not.toThrow();
  for (const current of [{ ...video, description: null }, { ...video, transcript: null }])
    expect(() => assertMaterialReadable(current)).toThrow('too large to edit here');
  for (const matches of [[false, true, true], [true, false, true], [true, true, false]])
    expect(() => assertMaterialReplayIdentity(matches[0], matches[1], matches[2])).toThrow('identifier has already been used');
  expect(() => assertMaterialOperationAvailable(false)).toThrow('operation is no longer available');
  expect(() => assertMaterialRevision('new', 'old')).toThrow('changed by another operation');
});
