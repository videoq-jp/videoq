import { describe, expect, it, vi } from 'vitest';
import type { CourseSkillPublicationRepository, CourseSkillPublication } from '../src/persistence/contracts/course-skill-publication-repository';
import { createMcpSkillsService, skillResourceUri } from '../src/features/mcp/skills-service';
import { dispatchModernMcp, MODERN_MCP_VERSION, isModernMcpRequest } from '../src/features/mcp/modern-http';
import { dispatchCourseSkillsMcp } from '../src/integrations/course-skills-mcp';
import type { Bindings } from '../src/types/bindings';

const p: CourseSkillPublication = { id: 'revision-a', courseId: 1, skillId: 'skill-a', name: 'videoq-c1-review-retry', description: '再試行をレビューする', manifest: [{ path: 'SKILL.md', digest: 'sha256:fixture', size: 12 }, { path: 'references/sources.md', digest: 'sha256:reference', size: 20 }] };
function setup() {
  let removed = false;
  const read = vi.fn(() => Promise.resolve(removed ? null : { path: 'SKILL.md', content: 'skill content', digest: 'sha256:fixture', size: 12 }));
  const repository: CourseSkillPublicationRepository = {
    approve: () => Promise.resolve(false), stage: () => Promise.resolve(false), publish: () => Promise.resolve(false), withdraw: () => Promise.resolve(false),
    managed: () => Promise.resolve([]),
    get: (_id, user) => Promise.resolve(!removed && user === 'owner' ? p : null), list: user => Promise.resolve(!removed && user === 'owner' ? [p] : []), read,
    page: user => Promise.resolve({ publications: !removed && user === 'owner' ? [p] : [], catalogIds: !removed && user === 'owner' ? [p.id] : [] }),
  };
  const tools = vi.fn(() => Promise.resolve({ tools: [] }));
  const deps = { skills: createMcpSkillsService(repository, 'owner'), tools };
  const call = (method: string, params: Record<string, unknown> = {}, changes: Record<string, string> = {}) => {
    const body = { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_MCP_VERSION,
      'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/skills': {} } },
    } } };
    const headers = new Headers({ 'MCP-Protocol-Version': MODERN_MCP_VERSION, 'Mcp-Method': method, ...(typeof params.uri === 'string' ? { 'Mcp-Name': params.uri } : {}), ...changes });
    return dispatchModernMcp(body, headers, deps);
  };
  return { deps, call, read, remove: () => { removed = true; }, repository };
}

describe('stateless Skills over MCP', () => {
  it('rejects continuation after catalog changes and across principals, including empty pages', async () => {
    const f = setup();
    let publications = Array.from({ length: 21 }, (_, index) => ({ ...p, id: `revision-${String(index).padStart(2, '0')}` }));
    f.repository.page = (_user, limit, after) => Promise.resolve({ catalogIds: publications.map(value => value.id), publications: publications.filter(value => value.id > after).slice(0, limit) });
    const service = createMcpSkillsService(f.repository, 'owner');
    const first = await service.list();
    expect(first.skills).toHaveLength(20);
    const cursor = first.nextCursor!;
    expect((await service.list(cursor)).skills.map(value => value.uri)).toEqual([skillResourceUri(publications[20])]);
    await expect(createMcpSkillsService(f.repository, 'other').list(cursor)).rejects.toThrow('restart listing');
    const original = publications;
    publications = [{ ...p, id: 'new-revision' }, ...original];
    await expect(service.list(cursor)).rejects.toThrow('restart listing');
    publications = original;
    publications = publications.slice(0, 20);
    await expect(service.list(cursor)).rejects.toThrow('restart listing');
    expect((await service.list()).skills).toHaveLength(20);
    publications = [];
    await expect(service.list(cursor)).rejects.toThrow('restart listing');
    expect((await service.list()).skills).toEqual([]);
    await expect(service.list('revision-19')).rejects.toThrow('Invalid cursor');
  });
  it('declares discovery without reading any files and returns complete skill manifests', async () => {
    const f = setup();
    expect((await f.call('server/discover')).body).toMatchObject({ result: { resultType: 'complete', supportedVersions: [MODERN_MCP_VERSION], capabilities: { resources: {}, extensions: { 'io.modelcontextprotocol/skills': {} } } } });
    expect((await f.call('skills/list')).body).toMatchObject({ result: { resultType: 'complete', ttlMs: 60000, cacheScope: 'private', skills: [{ frontmatter: { name: p.name, description: p.description }, resources: [{ uri: skillResourceUri(p), digest: 'sha256:fixture', size: 12 }, { uri: skillResourceUri(p, 'references/sources.md'), digest: 'sha256:reference', size: 20 }] }] } });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('reads only on demand and denies a previously known URI after revocation', async () => {
    const f = setup(); const uri = skillResourceUri(p);
    expect((await f.call('skills/get', { uri })).body).toMatchObject({ result: { skill: { uri } } });
    expect((await f.call('resources/read', { uri })).body).toMatchObject({ result: { contents: [{ uri, mimeType: 'text/markdown', text: 'skill content' }] } });
    f.remove();
    expect((await f.call('skills/get', { uri })).body).toMatchObject({ error: { code: -32602 } });
    expect((await f.call('resources/read', { uri })).body).toMatchObject({ error: { code: -32602 } });
    expect((await createMcpSkillsService(f.repository, 'other').list()).skills).toHaveLength(0);
  });
  it('rejects traversal, other-course aliases, and header/body disagreement', async () => {
    const f = setup();
    for (const uri of [skillResourceUri(p).replace('/courses/1/', '/courses/2/'), skillResourceUri(p, '../SKILL.md'), skillResourceUri(p, 'references/%2e%2e/SKILL.md')]) expect((await f.call('resources/read', { uri })).body).toMatchObject({ error: { code: -32602 } });
    expect((await f.call('skills/list', {}, { 'Mcp-Method': 'tools/call' })).body).toMatchObject({ error: { code: -32020 } });
    expect((await f.call('resources/read', { uri: skillResourceUri(p) }, { 'Mcp-Name': 'other' })).body).toMatchObject({ error: { code: -32020 } });
  });
  it('requires explicit per-request metadata and the client extension declaration', async () => {
    const f = setup();
    const headers = new Headers({ 'MCP-Protocol-Version': MODERN_MCP_VERSION, 'Mcp-Method': 'skills/list' });
    expect((await dispatchModernMcp({ jsonrpc: '2.0', id: 1, method: 'skills/list' }, headers, f.deps)).body).toMatchObject({ error: { code: -32602 } });
    expect((await dispatchModernMcp({ jsonrpc: '2.0', id: 1, method: 'skills/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_MCP_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} } } }, headers, f.deps)).body).toMatchObject({ error: { code: -32021 } });
  });
  it('recognizes modern requests while preserving legacy initialization traffic', () => {
    expect(isModernMcpRequest({ method: 'initialize', params: { protocolVersion: '2025-11-25' } }, new Headers())).toBe(false);
    expect(isModernMcpRequest({ method: 'server/discover' }, new Headers())).toBe(true);
  });
  it('redacts internal failures and returns a method-not-found HTTP status', async () => {
    const f = setup();
    expect((await f.call('not/a/method')).status).toBe(404);
    f.deps.tools.mockRejectedValueOnce(new Error('private SQL transcript'));
    const result = await f.call('tools/list');
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('private SQL');
  });
  it('bridges the modern tool catalog through the actual SDK transport without database or model calls', async () => {
    const method = 'tools/list';
    const result = await dispatchCourseSkillsMcp({ jsonrpc: '2.0', id: 1, method, params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_MCP_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }, new Headers({ 'MCP-Protocol-Version': MODERN_MCP_VERSION, 'Mcp-Method': method }), { env: {} as Bindings, userId: 'owner', canWrite: false });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ result: { resultType: 'complete', tools: expect.arrayContaining([expect.objectContaining({ name: 'search_scenes' })]) } });
  });
});
