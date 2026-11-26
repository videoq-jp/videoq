import { iterSrtCues } from '@videoq/domain/transcript';
import type { SkillDraft, SkillAudit, SkillPlan, ExtractedFacts } from '@videoq/domain/agent-skills';
import type { SkillMaterial, SkillCue, SkillFact } from './model';

export class SkillPolicyError extends Error {}

export const SKILL_CHUNK_CHARS = 12_000;
/** Traverse all subtitle text. Oversized cues keep their original timestamps. */
export function skillChunks(material: SkillMaterial): SkillCue[][] {
  if (!material.sources.length) throw new SkillPolicyError('Add analyzed videos before generating a skill.');
  const chunks: SkillCue[][] = [];
  for (const source of material.sources) {
    if (!source.transcript.trim()) throw new SkillPolicyError(`Video ${source.id} has no transcript.`);
    const parsed = [...iterSrtCues(source.transcript)];
    // Plain-text imports remain usable, but never receive fabricated timestamps.
    const cues = parsed.every(cue => cue !== null) ? parsed : [{ text: source.transcript, startTime: null, endTime: null }];
    let chunk: SkillCue[] = [], length = 0;
    cues.forEach((cue, index) => {
      if (!cue) return;
      for (let offset = 0; offset < cue.text.length; offset += SKILL_CHUNK_CHARS) {
        const text = cue.text.slice(offset, offset + SKILL_CHUNK_CHARS);
        if (length + text.length > SKILL_CHUNK_CHARS && chunk.length) { chunks.push(chunk); chunk = []; length = 0; }
        chunk.push({ id: `v${source.id}-c${index}-p${offset}`, videoId: source.id, title: source.title, start: cue.startTime, end: cue.endTime, text });
        length += text.length;
      }
    });
    if (chunk.length) chunks.push(chunk);
  }
  if (!chunks.length) throw new SkillPolicyError('No readable source text.');
  return chunks;
}

export function checkedFacts(value: ExtractedFacts, cues: SkillCue[], chunkIndex: number): SkillFact[] {
  const parsed = value;
  for (const fact of parsed.facts) for (const evidence of fact.evidence) {
    const cue = cues.find(cue => cue.id === evidence.cueId);
    if (!cue || !cue.text.includes(evidence.quote)) throw new SkillPolicyError('Generated evidence did not match the source. Retry this step.');
  }
  return parsed.facts.map((fact, index) => ({ ...fact, id: `chunk-${chunkIndex}-fact-${index}` }));
}

/** Every extracted fact must survive planning; facts may support several related skills. */
export function checkedPlan(value: SkillPlan, facts: SkillFact[]) {
  const plan = value;
  const known = new Set(facts.map(fact => fact.id));
  const assigned = new Set(plan.skills.flatMap(skill => skill.factIds));
  if ([...assigned].some(id => !known.has(id))) throw new SkillPolicyError('The skill plan cites an unknown fact. Retry planning.');
  if (facts.some(fact => !assigned.has(fact.id))) throw new SkillPolicyError('The skill plan omitted source knowledge. Retry planning.');
  if (new Set(plan.skills.map(skill => skill.objective)).size !== plan.skills.length || plan.skills.some(skill => new Set(skill.factIds).size !== skill.factIds.length)) throw new SkillPolicyError('The skill plan contains duplicate entries. Retry planning.');
  return plan;
}

export function draftClaims(draft: SkillDraft) {
  return [
    ...draft.criteria.map((item, i) => ({ id: `criterion-${i}`, text: item.decision, factIds: item.factIds })),
    ...draft.steps.map((item, i) => ({ id: `step-${i}`, text: `${item.action}\nExpected: ${item.expectedResult}`, factIds: item.factIds })),
    ...draft.exceptions.map((item, i) => ({ id: `exception-${i}`, text: `${item.condition}\n${item.behavior}`, factIds: item.factIds })),
    ...draft.checks.map((item, i) => ({ id: `check-${i}`, text: item.check, factIds: item.factIds })),
    ...draft.examples.map((item, i) => ({ id: `example-${i}`, text: `${item.situation}\n${item.application}`, factIds: item.factIds })),
  ];
}

export function checkedDraft(value: SkillDraft, facts: SkillFact[]): SkillDraft {
  const draft = value;
  const ids = new Set(facts.map(fact => fact.id));
  for (const claim of draftClaims(draft)) if (claim.factIds.some(id => !ids.has(id))) throw new SkillPolicyError('Generated skill cited an unknown fact. Retry this step.');
  // Preserve source qualifications instead of dropping all exceptions/examples during synthesis.
  if (facts.some(f => f.kind === 'exception') && !draft.exceptions.length) throw new SkillPolicyError('The skill omitted source exceptions. Retry synthesis.');
  const exceptionIds = new Set(draft.exceptions.flatMap(item => item.factIds));
  if (facts.some(f => f.kind === 'exception' && !exceptionIds.has(f.id))) throw new SkillPolicyError('The skill omitted a source exception. Retry synthesis.');
  if (facts.some(f => f.kind === 'example') && !draft.examples.length) throw new SkillPolicyError('The skill omitted source examples. Retry synthesis.');
  return draft;
}

export function auditIssues(value: SkillAudit, draft: SkillDraft): string[] {
  const audit = value;
  const claims = draftClaims(draft);
  const ids = audit.checks.map(check => check.claimId);
  if (ids.length !== claims.length || new Set(ids).size !== ids.length || claims.some(claim => !ids.includes(claim.id))) throw new SkillPolicyError('The quality check did not cover every skill claim. Retry this step.');
  return [...(!audit.routingAppropriate ? ['The skill activation conditions do not match the requested task and source material.'] : []),
    ...audit.checks.filter(check => !check.grounded || !check.actionable).map(check => `${check.claimId}: ${check.reason}`)];
}
