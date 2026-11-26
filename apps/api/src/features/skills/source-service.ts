import type { SkillTarget, SkillSource, SkillMaterial } from '../../domain/skills/model';
import { acceptSkillSourcePage, completeSkillSourcePages, checkedSkillSource, SkillSourceError } from '../../domain/skills/source-policy';
import { notFound, conflict, validationFailure } from '../../application/errors';
export interface SkillSourceDependencies {
  coursePage(ownerId: string, courseId: number, offset: number): Promise<{ role: string; title: string; count: number; ids: number[] } | null>;
  sources(ownerId: string, ids: number[]): Promise<(SkillSource & { status: string })[]>;
}
export function createSkillSourceService(deps: SkillSourceDependencies) {
  return async (ownerId: string, target: SkillTarget): Promise<SkillMaterial> => {
    try {
      let ids: number[], title = '';
      if (target.kind === 'course') {
        let state = { title: '', expected: -1, ids: [] as number[], offset: 0 };
        do { state = acceptSkillSourcePage(state, await deps.coursePage(ownerId, target.resourceId, state.offset)); } while (state.offset < state.expected);
        completeSkillSourcePages(state); ids = state.ids; title = state.title;
      } else ids = [target.resourceId];
      const sources: SkillSource[] = [];
      for (let offset = 0; offset < ids.length; offset += 90) {
        const page = ids.slice(offset, offset + 90), rows = await deps.sources(ownerId, page);
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const id of page) sources.push(checkedSkillSource(id, byId.get(id)));
      }
      return { title: title || sources[0]?.title || '', sources };
    } catch (error) {
      if (!(error instanceof SkillSourceError)) throw error;
      if (error.reason === 'course' || error.reason === 'video') throw notFound(error.message);
      if (error.reason === 'changed') throw conflict(error.message);
      throw validationFailure(error.message);
    }
  };
}
