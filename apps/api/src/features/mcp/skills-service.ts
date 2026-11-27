import type { CourseSkillPublication, CourseSkillPublicationRepository } from '../../persistence/contracts/course-skill-publication-repository';

export class SkillLookupError extends Error {}
export const skillResourceUri = (p: CourseSkillPublication, path = 'SKILL.md') =>
  `skill://videoq/courses/${p.courseId}/skills/${encodeURIComponent(p.skillId)}/revisions/${encodeURIComponent(p.id)}/${p.name}/${path}`;
function entry(p: CourseSkillPublication) {
  return { uri: skillResourceUri(p), frontmatter: { name: p.name, description: p.description },
    resources: p.manifest.map(f => ({ uri: skillResourceUri(p, f.path), digest: f.digest, size: f.size })) };
}
function parseUri(uri: string) {
  const match = /^skill:\/\/videoq\/courses\/([1-9][0-9]*)\/skills\/([^/]+)\/revisions\/([^/]+)\/([a-z0-9-]+)\/(SKILL\.md|references\/[a-z0-9-]+\.md)$/.exec(uri);
  if (!match) throw new SkillLookupError('Unknown skill or file');
  return { courseId: Number(match[1]), skillId: decodeURIComponent(match[2]), id: decodeURIComponent(match[3]), name: match[4], path: match[5] };
}
const cache = { resultType: 'complete' as const, ttlMs: 60_000, cacheScope: 'private' as const };
export function createMcpSkillsService(repository: CourseSkillPublicationRepository, userId: string) {
  async function resolve(uri: string) {
    let parsed: ReturnType<typeof parseUri>;
    try { parsed = parseUri(uri); } catch { throw new SkillLookupError('Unknown skill or file'); }
    const p = await repository.get(parsed.id, userId);
    if (!p || p.courseId !== parsed.courseId || p.skillId !== parsed.skillId || p.name !== parsed.name || !p.manifest.some(f => f.path === parsed.path)) throw new SkillLookupError('Unknown skill or file');
    return { p, parsed };
  }
  return {
    async list(cursor?: string) {
      // Opaque cursor contains only a public revision ID; authorization is repeated on every page.
      let after = '';
      if (cursor) {
        if (cursor.length > 1024) throw new SkillLookupError('Invalid cursor');
        try { after = decodeURIComponent(cursor); } catch { throw new SkillLookupError('Invalid cursor'); }
      }
      const publications = await repository.list(userId, 21, after);
      const page = publications.slice(0, 20);
      return { ...cache, skills: page.map(entry), ...(publications.length > 20 ? { nextCursor: encodeURIComponent(page.at(-1)!.id) } : {}) };
    },
    async get(uri: string) {
      const { p, parsed } = await resolve(uri);
      if (parsed.path !== 'SKILL.md') throw new SkillLookupError('Unknown skill');
      return { ...cache, skill: entry(p) };
    },
    async read(uri: string) {
      const { p, parsed } = await resolve(uri);
      const file = await repository.read(p.id, parsed.path, userId);
      if (!file) throw new SkillLookupError('Unknown skill or file');
      return { ...cache, contents: [{ uri, mimeType: 'text/markdown', text: file.content }] };
    },
  };
}
