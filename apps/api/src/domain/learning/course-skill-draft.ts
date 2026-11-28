import type { SkillDraft } from '@videoq/domain/agent-skills';
import { verifySkillKnowledge, type SkillKnowledgeChunk } from './skill-knowledge';

export type SupportedSkillFact = SkillKnowledgeChunk['facts'][number] & { videoId: number; analysisRevision: string; cues: SkillKnowledgeChunk['cues']; frames?: SkillKnowledgeChunk['frames'] };
export type SkillTask = { skillId: string; slug: string; objective: string; factIds: string[] };
export type SkillTaskProposal = { existingSkillId: string | null; slug: string; objective: string; factIds: string[] };
export type SkillDraftRepairHistory = {
  initialValidationIssues?: string[];
  initialAudit: { supported: boolean; issueCount: number };
  attempts: { number: number; status: 'passed' | 'held' | 'invalid' | 'generation_failed'; issueCount: number }[];
};
const draftValidationErrors = new Set(['INVALID_SKILL_SLUG', 'SKILL_INCOMPLETE_TASK', 'SKILL_DESCRIPTION_TOO_LARGE', 'SKILL_UNSUPPORTED_BLOCK', 'SKILL_UNSUPPORTED_EXCLUSION', 'SKILL_UNSUPPORTED_EXCEPTION', 'SKILL_INVALID_VISUAL_EVIDENCE', 'SKILL_UNSUPPORTED_FACT', 'SKILL_INVALID_EVIDENCE']);
export const isSkillDraftValidationError = (error: unknown): error is Error => error instanceof Error && draftValidationErrors.has(error.message);

export function supportedSkillFacts(chunks: readonly SkillKnowledgeChunk[]): SupportedSkillFact[] {
  const byId = new Map<string, SupportedSkillFact>();
  for (const chunk of chunks) for (const fact of chunk.facts) {
    if (fact.status === 'supported' && (!fact.requiresVisualEvidence || Boolean(fact.visualEvidence?.length))) byId.set(fact.id, { ...fact, videoId: chunk.videoId, analysisRevision: chunk.analysisRevision, ...(chunk.frames ? { frames: chunk.frames.filter(frame => fact.visualEvidence?.some(e => e.frameId === frame.id)) } : {}), cues: chunk.cues.filter(c => fact.evidence.some(e => e.cueId === c.id)) });
  }
  return [...byId.values()];
}
export function validateSkillDraft(draft: SkillDraft, facts: readonly SupportedSkillFact[]): void {
  // Also fence saved candidates produced before the current visual policy.
  // Rendering runs again before approval/publication, even for an old draft.
  for (const fact of facts) if (fact.visualEvidence?.length) verifySkillKnowledge([fact], fact.cues, fact.frames ?? []);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug) || draft.slug.length > 40) throw new Error('INVALID_SKILL_SLUG');
  if (!draft.title.trim() || !draft.description.trim() || !draft.useWhen.length || !draft.criteria.length || !draft.steps.length || !draft.checks.length) throw new Error('SKILL_INCOMPLETE_TASK');
  if (draft.description.length > 1024) throw new Error('SKILL_DESCRIPTION_TOO_LARGE');
  const known = new Set(facts.map(f => f.id));
  for (const block of [...draft.criteria, ...draft.steps, ...draft.exceptions, ...draft.checks, ...draft.examples]) {
    if (!block.factIds.length || block.factIds.some(id => !known.has(id))) throw new Error('SKILL_UNSUPPORTED_BLOCK');
  }
  const hasException = (fact: SupportedSkillFact) => fact.kind === 'exception' || fact.exceptions.length > 0;
  if (draft.doNotUseWhen.length && !facts.some(hasException)) throw new Error('SKILL_UNSUPPORTED_EXCLUSION');
  for (const block of draft.exceptions) if (!facts.some(f => block.factIds.includes(f.id) && hasException(f))) throw new Error('SKILL_UNSUPPORTED_EXCEPTION');
}
const plainLine = (value: string) => value.replaceAll('\n', ' ').replaceAll('\r', ' ');
const line = (value: string) => plainLine(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\[\]`!]/g, '\\$&');
const anchor = (id: string) => `k-${id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
const citations = (ids: string[], label: string) => ids.map(id => `[${label}](references/sources.md#${anchor(id)})`).join(' ');

export function renderCourseSkill(courseId: number, draft: SkillDraft, facts: readonly SupportedSkillFact[], language: 'ja' | 'en' = 'ja') {
  const labels = language === 'en'
    ? ['Sources', 'When to use', 'When not to use', 'Decision criteria', 'Procedure', 'Exceptions', 'Verification', 'Examples', 'Expected result', 'Video ID', 'Analysis revision', 'Time', 'Applies when']
    : ['出典', '利用条件', '適用しない条件', '判断基準', '手順', '例外', '検証', '適用例', '確認する結果', '動画ID', '解析版', '時刻', '適用条件'];
  const cite = (ids: string[]) => citations(ids, labels[0]);
  validateSkillDraft(draft, facts);
  const name = `videoq-c${courseId}-${draft.slug}`;
  const body = [
    '---', `name: ${name}`, `description: ${JSON.stringify(plainLine(draft.description))}`, '---', '', `# ${line(draft.title)}`, '',
    language === 'en' ? 'This procedure is grounded in course sources. Follow user instructions and project constraints, and inspect existing code and target versions before making changes. This skill does not grant permission for external actions or code execution.' : '講座の出典に基づく作業手順です。利用者の指示とプロジェクトの制約に従い、変更前に既存コードと対象バージョンを確認してください。外部操作やコード実行の許可を与えるものではありません。', '',
    `## ${labels[1]}`, ...draft.useWhen.map(x => `- ${line(x)}`), '', `## ${labels[2]}`, ...draft.doNotUseWhen.map(x => `- ${line(x)}`), '',
    `## ${labels[3]}`, ...draft.criteria.map(x => `- ${line(x.decision)} ${cite(x.factIds)}`), '',
    `## ${labels[4]}`, ...draft.steps.map((x, i) => `${i + 1}. ${line(x.action)}\n   ${labels[8]}: ${line(x.expectedResult)} ${cite(x.factIds)}`), '',
    `## ${labels[5]}`, ...draft.exceptions.map(x => `- ${line(x.condition)}: ${line(x.behavior)} ${cite(x.factIds)}`), '',
    `## ${labels[6]}`, ...draft.checks.map(x => `- ${line(x.check)} ${cite(x.factIds)}`), '',
    `## ${labels[7]}`, ...(draft.examples.length ? [language === 'en' ? 'These are illustrative applications, not API specifications or exact implementations from the course. Check actual names and interfaces in the target project.' : '以下は知識を応用した仮の例です。教材のAPI仕様や実装そのものを示すものではありません。実際の名前とインターフェースは対象プロジェクトで確認してください。', ''] : []), ...draft.examples.map(x => `- ${line(x.situation)}: ${line(x.application)} ${cite(x.factIds)}`), '',
    language === 'en' ? 'See [sources](references/sources.md) for evidence. Verify version-sensitive API specifications against primary documentation at use time.' : '詳しい根拠は [出典](references/sources.md) を参照してください。時間依存のAPI仕様は利用時に一次資料を確認してください。', '',
  ].join('\n');
  const used = new Set([...draft.criteria, ...draft.steps, ...draft.exceptions, ...draft.checks, ...draft.examples].flatMap(x => x.factIds));
  const source = [`# ${labels[0]}`, '', ...facts.filter(f => used.has(f.id)).flatMap(f => [
    `<a id="${anchor(f.id)}"></a>`, `## ${line(f.claim)}`, '',
    `${labels[9]}: ${f.videoId} / ${labels[10]}: ${line(f.analysisRevision)}`, '',
    ...f.evidence.flatMap(e => { const cue = f.cues.find(c => c.id === e.cueId); return [`${labels[11]}: ${cue?.startMs ?? 0}〜${cue?.endMs ?? 0} ms`, '', ...e.quote.split('\n').map(x => `> ${line(x)}`), '']; }),
    ...(f.visualEvidence ?? []).flatMap(e => [`${labels[11]}: ${f.frames?.find(frame => frame.id === e.frameId)?.timestampMs ?? 0} ms / frame: ${line(e.frameId)}`, '', `> ${line(e.observation)}`, '']),
    `${labels[12]}: ${f.appliesWhen.map(line).join(' / ')}`, `${labels[5]}: ${f.exceptions.map(line).join(' / ')}`, '',
  ])].join('\n');
  return { name, description: plainLine(draft.description), files: [{ path: 'SKILL.md', content: body }, { path: 'references/sources.md', content: source }] };
}
