import { z } from 'zod';
import { extractedFactsSchema } from '@videoq/trpc/skills';
import type { SkillCue } from '../../persistence/contracts/agent-skill-repository';

/** The model selects source passages; only the server writes verbatim quotes. */
export function extractionEvidence(cues: SkillCue[]) {
  const passages = cues.flatMap(cue => {
    const chars = Array.from(cue.text);
    if (chars.length < 4) return [];
    // At most 800 UTF-16 units, without splitting a surrogate pair or losing a short tail.
    const count = Math.ceil(chars.length / 400);
    const size = Math.ceil(chars.length / count);
    return Array.from({ length: count }, (_, index) => ({
      id: `${cue.id}-e${index}`, cueId: cue.id,
      quote: chars.slice(index * size, (index + 1) * size).join(''),
    }));
  });
  const ids = passages.map(passage => passage.id);
  const fact = extractedFactsSchema.shape.facts.element;
  const schema = z.object({ facts: z.array(fact.extend({
    evidence: z.array(z.object({ sourceId: ids.length ? z.enum(ids as [string, ...string[]]) : z.never() })).min(1).max(3),
  })).max(12) });
  return {
    passages, schema,
    resolve(value: unknown) {
      const parsed = schema.parse(value);
      const byId = new Map(passages.map(passage => [passage.id, passage]));
      return extractedFactsSchema.parse({ facts: parsed.facts.map(item => ({ ...item,
        evidence: item.evidence.map(({ sourceId }) => {
          const source = byId.get(sourceId)!;
          return { cueId: source.cueId, quote: source.quote };
        }),
      })) });
    },
  };
}
