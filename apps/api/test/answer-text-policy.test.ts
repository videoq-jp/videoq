import { expect, it } from 'vitest';
import { assertAnswerHasText, StructuredAnswerError } from '../src/domain/conversation/answer-generation';

it.each([[], [''], [' ', '\n\t', '\u3000']].map(texts => ({ texts })))('rejects answers without visible text: $texts', ({ texts }) => {
  expect(() => assertAnswerHasText({ segments: texts.map(text => ({ text, sourceIds: [] })) }))
    .toThrow(StructuredAnswerError);
});

it('accepts a meaningful segment without rewriting whitespace in any segment', () => {
  const answer = { segments: [{ text: ' \n', sourceIds: [] }, { text: ' 回答 🙂 ', sourceIds: [] }] };
  const before = structuredClone(answer);
  expect(() => assertAnswerHasText(answer)).not.toThrow();
  expect(answer).toEqual(before);
});
