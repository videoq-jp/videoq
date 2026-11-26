import { describe, expect, it } from 'vitest';
import { extractionEvidence } from '../src/features/skills/evidence';
import { checkedFacts } from '../src/features/skills/core';
import type { SkillCue } from '../src/persistence/contracts/agent-skill-repository';
const cue = (id: string, text: string): SkillCue => ({ id, text, videoId: 1, title: 'Lesson', start: null, end: null });
const fact = (ids: string[]) => ({ facts: [{ kind: 'procedure', claim: 'Keep the source condition.', appliesWhen: 'Following the lesson.', evidence: ids.map(sourceId => ({ sourceId })) }] });
describe('server-owned extraction evidence', () => {
  it('copies exact Japanese source text across subtitles without model transcription', () => {
    const cues = [cue('a', 'テストを先に書き、'), cue('b', '失敗を確認してから実装します。')];
    const extraction = extractionEvidence(cues);
    const facts = checkedFacts(extraction.resolve(fact(extraction.passages.map(p => p.id))), cues, 0);
    expect(facts[0].evidence).toEqual(cues.map(c => ({ cueId: c.id, quote: c.text })));
  });
  it('rejects unknown references instead of substituting unrelated source text', () => {
    const extraction = extractionEvidence([cue('a', 'Preserve the condition.')]);
    expect(() => extraction.resolve(fact(['invented']))).toThrow();
  });
  it('preserves all long source text including short tails and surrogate pairs', () => {
    for (const text of ['x'.repeat(801), '😀'.repeat(801), '条件'.repeat(12000)]) {
      const cues = [cue('a', text)];
      const extraction = extractionEvidence(cues);
      expect(extraction.passages.map(p => p.quote).join('')).toBe(text);
      for (const passage of extraction.passages) {
        expect(passage.quote.length).toBeGreaterThanOrEqual(4);
        expect(passage.quote.length).toBeLessThanOrEqual(800);
        expect(passage.quote.isWellFormed()).toBe(true);
        expect(() => checkedFacts(extraction.resolve(fact([passage.id])), cues, 0)).not.toThrow();
      }
    }
  });
  it('permits empty extraction when there is no usable evidence', () => {
    const extraction = extractionEvidence([cue('a', 'はい')]);
    expect(extraction.resolve({ facts: [] })).toEqual({ facts: [] });
    expect(() => extraction.resolve(fact(['a-e0']))).toThrow();
  });
});
