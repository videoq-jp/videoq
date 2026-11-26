import type { SkillSource } from './model';
export class SkillSourceError extends Error {
  constructor(readonly reason: 'course' | 'changed' | 'video' | 'notReady', message: string) { super(message); }
}
export type SkillSourcePageState = { title: string; expected: number; ids: number[]; offset: number };
export function acceptSkillSourcePage(state: SkillSourcePageState, page: { role: string; title: string; count: number; ids: number[] } | null): SkillSourcePageState {
  if (!page || page.role !== 'owner') throw new SkillSourceError('course', 'Owned course not found.');
  if (state.expected !== -1 && (page.count !== state.expected || page.title !== state.title)) throw new SkillSourceError('changed', 'Source videos changed. Retry generation.');
  if (page.ids.some(id => state.ids.includes(id)) || (!page.ids.length && state.offset < page.count)) throw new SkillSourceError('changed', 'Source videos changed. Retry generation.');
  return { title: page.title, expected: page.count, ids: [...state.ids, ...page.ids], offset: state.offset + page.ids.length };
}
export function completeSkillSourcePages(state: SkillSourcePageState): void {
  if (state.ids.length !== state.expected) throw new SkillSourceError('changed', 'Source videos changed. Retry generation.');
}
export function checkedSkillSource(id: number, source: (SkillSource & { status: string }) | undefined): SkillSource {
  if (!source) throw new SkillSourceError('video', 'An owned source video is no longer available.');
  if (source.status !== 'completed' || !source.transcript.trim()) throw new SkillSourceError('notReady', `Finish analysis for video ${id} before generating a skill.`);
  return { id: source.id, title: source.title, transcript: source.transcript };
}
