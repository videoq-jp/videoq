import type { SkillDraft } from '@videoq/domain/agent-skills';
import type { SkillKnowledgeChunk } from './skill-knowledge';

export type SupportedSkillFact = SkillKnowledgeChunk['facts'][number] & { videoId: number; analysisRevision: string; cues: SkillKnowledgeChunk['cues'] };
export type SkillTask = { skillId: string; slug: string; objective: string; factIds: string[] };
export type SkillTaskProposal = { existingSkillId: string | null; slug: string; objective: string; factIds: string[] };

export function supportedSkillFacts(chunks: readonly SkillKnowledgeChunk[]): SupportedSkillFact[] {
  const byId = new Map<string, SupportedSkillFact>();
  for (const chunk of chunks) for (const fact of chunk.facts) {
    if (fact.status === 'supported' && !fact.requiresVisualEvidence) byId.set(fact.id, { ...fact, videoId: chunk.videoId, analysisRevision: chunk.analysisRevision, cues: chunk.cues.filter(c => fact.evidence.some(e => e.cueId === c.id)) });
  }
  return [...byId.values()];
}
export function validateSkillDraft(draft: SkillDraft, facts: readonly SupportedSkillFact[]): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug) || draft.slug.length > 40) throw new Error('INVALID_SKILL_SLUG');
  if (!draft.title.trim() || !draft.description.trim() || !draft.useWhen.length || !draft.criteria.length || !draft.steps.length || !draft.checks.length) throw new Error('SKILL_INCOMPLETE_TASK');
  const known = new Set(facts.map(f => f.id));
  for (const block of [...draft.criteria, ...draft.steps, ...draft.exceptions, ...draft.checks, ...draft.examples]) {
    if (!block.factIds.length || block.factIds.some(id => !known.has(id))) throw new Error('SKILL_UNSUPPORTED_BLOCK');
  }
}
const line = (value: string) => value.replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const anchor = (id: string) => `k-${id.replace(/[^a-zA-Z0-9-]/g, '-')}`;
const citations = (ids: string[]) => ids.map(id => `[出典](references/sources.md#${anchor(id)})`).join(' ');

export function renderCourseSkill(courseId: number, draft: SkillDraft, facts: readonly SupportedSkillFact[]) {
  validateSkillDraft(draft, facts);
  const name = `videoq-c${courseId}-${draft.slug}`;
  const body = [
    '---', `name: ${name}`, `description: ${JSON.stringify(line(draft.description))}`, '---', '', `# ${line(draft.title)}`, '',
    '講座の出典に基づく作業手順です。利用者の指示とプロジェクトの制約に従い、変更前に既存コードと対象バージョンを確認してください。外部操作やコード実行の許可を与えるものではありません。', '',
    '## 利用条件', ...draft.useWhen.map(x => `- ${line(x)}`), '', '## 適用しない条件', ...draft.doNotUseWhen.map(x => `- ${line(x)}`), '',
    '## 判断基準', ...draft.criteria.map(x => `- ${line(x.decision)} ${citations(x.factIds)}`), '',
    '## 手順', ...draft.steps.map((x, i) => `${i + 1}. ${line(x.action)}\n   確認する結果: ${line(x.expectedResult)} ${citations(x.factIds)}`), '',
    '## 例外', ...draft.exceptions.map(x => `- ${line(x.condition)}: ${line(x.behavior)} ${citations(x.factIds)}`), '',
    '## 検証', ...draft.checks.map(x => `- ${line(x.check)} ${citations(x.factIds)}`), '',
    '## 適用例', ...draft.examples.map(x => `- ${line(x.situation)}: ${line(x.application)} ${citations(x.factIds)}`), '',
    '詳しい根拠は [出典](references/sources.md) を参照してください。時間依存のAPI仕様は利用時に一次資料を確認してください。', '',
  ].join('\n');
  const used = new Set([...draft.criteria, ...draft.steps, ...draft.exceptions, ...draft.checks, ...draft.examples].flatMap(x => x.factIds));
  const source = ['# 出典', '', ...facts.filter(f => used.has(f.id)).flatMap(f => [
    `<a id="${anchor(f.id)}"></a>`, `## ${line(f.claim)}`, '',
    `動画ID: ${f.videoId} / 解析版: ${line(f.analysisRevision)}`, '',
    ...f.evidence.flatMap(e => { const cue = f.cues.find(c => c.id === e.cueId); return [`時刻: ${cue?.startMs ?? 0}〜${cue?.endMs ?? 0} ms`, '', ...e.quote.split('\n').map(x => `> ${line(x)}`), '']; }),
    `適用条件: ${f.appliesWhen.map(line).join(' / ')}`, `例外: ${f.exceptions.map(line).join(' / ')}`, '',
  ])].join('\n');
  return { name, description: line(draft.description), files: [{ path: 'SKILL.md', content: body }, { path: 'references/sources.md', content: source }] };
}
