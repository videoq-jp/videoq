import { expect, it, vi } from 'vitest';
import { validateAnswerCitations } from '../src/domain/conversation/citation-policy';
import { AnswerContentService, type AnswerTextParser } from '../src/features/chat/answer-content-service';
import { StructuredAnswerError } from '../src/domain/conversation/answer-generation';

const source = { id: 12, video_id: 1, title: 'private title', start_time: null, end_time: null };
it('retains prose while removing unauthorized citation identities and reports counts only', () => {
  const onRejected = vi.fn();
  const answer = validateAnswerCitations({ segments: [{ text: 'Answer', sourceIds: [12, 99, 12, 0] }] }, [source], {
    validateSource: () => {}, onRejected,
  });
  expect(answer.segments).toEqual([{ text: 'Answer', sourceIds: [12] }]);
  expect(onRejected).toHaveBeenCalledExactlyOnceWith({ invalid_id: 1, unknown_id: 1, duplicate_id: 1, unsafe_position: 0 });
});
it('rejects a duplicate source registry before using it to authorize citations', () => {
  const onRejected = vi.fn();
  expect(() => validateAnswerCitations({ segments: [{ text: 'Answer', sourceIds: [12] }] }, [source, source], {
    validateSource: () => {}, onRejected,
  })).toThrow('Duplicate source ID');
  expect(onRejected).not.toHaveBeenCalled();
});
it('rejects final citation replacement using only the parser contract, without loading an SDK', () => {
  const parsed = { segments: [{ text: 'Answer.', sourceIds: [12] }] };
  const parser: AnswerTextParser = {
    push: () => [{ segmentIndex: 0, text: 'Answer.' }], completedSegments: () => parsed.segments,
    text: () => 'Answer.', finish: () => parsed,
  };
  const service = new AnswerContentService(parser);
  expect(service.push('opaque parser input', [source])).toEqual([
    { type: 'text', segmentIndex: 0, text: 'Answer.' }, { type: 'citation', segmentIndex: 0, sourceId: 12 },
  ]);
  expect(() => service.finish({ segments: [{ text: 'Answer.', sourceIds: [] }], sources: [source] })).toThrow(StructuredAnswerError);
});
