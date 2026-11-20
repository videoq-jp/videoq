import { describe, expect, it } from 'vitest';
import {
  transcriptionCompletion, transcriptionFinishAllowed, transcriptionPlan, transcriptionQuotaAllowed,
  transcriptionRejectionAllowed, transcriptionRunActive, transcriptionRunReusable, validTranscriptionSegments, validateTranscriptionBegin,
  validateTranscriptionFinish, type TranscriptionChoice,
} from '../src/application/transcription-policy';

const logic: TranscriptionChoice<string, boolean> = {
  and: (...terms) => terms.every(Boolean), or: (...terms) => terms.some(Boolean), not: value => !value,
  choose: (condition, yes, no) => condition ? yes : no, literal: value => value,
};

describe('transcription domain rules', () => {
  it('rounds billing independently of chunk size and keeps partial final chunks', () => {
    expect(transcriptionPlan(300001, 300)).toEqual({ count: 2, seconds: 301 });
    expect(transcriptionPlan(3_000_000_000, 300)).toEqual({ count: 10000, seconds: 3_000_000 });
    expect(transcriptionPlan(1, 30)).toEqual({ count: 1, seconds: 1 });
  });
  it.each([[0, 300], [-1, 300], [NaN, 300], [Infinity, 300], [1.1, 300], [3_000_000_001, 300],
    [1, 29], [1, 301], [1, 30.1], [300_000_001, 30]])('refuses invalid plan %s/%s', (duration, chunk) => {
    expect(() => transcriptionPlan(duration, chunk)).toThrow('Invalid transcription plan');
  });
  it('accepts empty and zero-duration chunks but refuses malformed timestamps or text', () => {
    expect(validTranscriptionSegments([])).toBe(true);
    expect(validTranscriptionSegments([{ start: 0, end: 0, text: '' }])).toBe(true);
    for (const segment of [{ start: -1, end: 0, text: '' }, { start: 2, end: 1, text: '' },
      { start: 0, end: Infinity, text: '' }, { start: NaN, end: 1, text: '' }]) {
      expect(validTranscriptionSegments([segment])).toBe(false);
    }
  });
  it('does not reuse a completed run or permit writes after source handoff', () => {
    expect(transcriptionRunReusable({ sameFile: true, sameRevision: true, incomplete: false }, logic)).toBe(false);
    expect(transcriptionRunReusable({ sameFile: true, sameRevision: false, incomplete: true }, logic)).toBe(false);
    expect(transcriptionRunActive({ belongsToVideo: true, reusable: true, eligibleSource: false }, logic)).toBe(false);
  });
  it('keeps previously reserved processing retryable even after quota changes', () => {
    expect(transcriptionQuotaAllowed({ alreadyReserved: true, notOverQuota: false, representable: false, withinLimit: false }, logic)).toBe(true);
    expect(transcriptionQuotaAllowed({ alreadyReserved: false, notOverQuota: false, representable: true, withinLimit: true }, logic)).toBe(false);
    expect(transcriptionQuotaAllowed({ alreadyReserved: false, notOverQuota: true, representable: true, withinLimit: true }, logic)).toBe(true);
  });
  it('allows error recovery only with a complete current checkpoint run', () => {
    expect(transcriptionFinishAllowed({ processing: false, error: true, hasRun: false, completeCurrentRun: true }, logic)).toBe(false);
    expect(transcriptionFinishAllowed({ processing: false, error: true, hasRun: true, completeCurrentRun: true }, logic)).toBe(true);
    expect(transcriptionFinishAllowed({ processing: true, error: false, hasRun: true, completeCurrentRun: false }, logic)).toBe(false);
    expect(transcriptionFinishAllowed({ processing: true, error: false, hasRun: false, completeCurrentRun: false }, logic)).toBe(true);
  });
  it('allows source-level no-audio rejection but fences a requested stale or finished run', () => {
    expect(transcriptionRejectionAllowed(false, false, logic)).toBe(true);
    expect(transcriptionRejectionAllowed(true, false, logic)).toBe(false);
    expect(transcriptionRejectionAllowed(true, true, logic)).toBe(true);
  });
  it.each([
    [false, false, false, 'completed', ''], [false, true, false, 'completed', ''],
    [true, false, false, 'error', 'TRANSCRIPTION_FAILED'], [true, true, true, 'indexing', ''],
  ])('preserves manual edits and maps completion %s/%s', (sameRevision, hasTranscript, saveTranscript, status, error) => {
    expect(transcriptionCompletion(sameRevision, hasTranscript, 'TRANSCRIPTION_FAILED', logic)).toEqual({ saveTranscript, status, error });
  });
  it('rejects unready states and unapproved failure codes while allowing empty transcript success', () => {
    expect(() => validateTranscriptionBegin('uploading')).toThrow('Invalid transcription state');
    expect(() => validateTranscriptionFinish(null, 'provider secret')).toThrow('Invalid transcription failure');
    expect(() => validateTranscriptionFinish('', null)).not.toThrow();
    expect(() => validateTranscriptionFinish(null, 'PROCESSING_QUOTA_EXCEEDED')).not.toThrow();
  });
});
