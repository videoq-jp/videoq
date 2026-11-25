import { it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSkillTools } from '../src/tools/agent-skills';
import { registerTools } from '../src/tools/mcp';
import { agentSkillService } from '../src/integrations/agent-skills';
import { conflict } from '../src/application/errors';
import type { Bindings } from '../src/types/bindings';
import { skillFixtureId } from './fixtures/agent-skill';
vi.mock('../src/integrations/agent-skills', () => ({ agentSkillService: vi.fn() }));

it('exposes a read-only published artifact and preserves review/source errors over the MCP SDK', async () => {
  const first = { id: skillFixtureId, name: 'videoq-lab-3dc4072c', files: {
    'SKILL.md': '---\nname: videoq-lab-3dc4072c\n---\nUse the course decisions.', 'references/sources.md': '# Evidence' } };
  const bundle = vi.fn().mockResolvedValue({ ...first, skills: [first, { ...first, name: 'videoq-sql-3dc4072c', files: { ...first.files, 'SKILL.md': first.files['SKILL.md'].replaceAll(first.name, 'videoq-sql-3dc4072c') } }] });
  vi.mocked(agentSkillService).mockResolvedValue({ bundle } as unknown as Awaited<ReturnType<typeof agentSkillService>>);
  const server = new McpServer({ name: 'skill-test', version: '1' });
  registerTools(server, createSkillTools({ env: { FRONTEND_URL: 'https://videoq.example' } as Bindings, userId: 'owner', canWrite: false }));
  const client = new Client({ name: 'skill-test', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools[0]).toMatchObject({ name: 'get_skill', annotations: { readOnlyHint: true, destructiveHint: false } });
    const result = await client.callTool({ name: 'get_skill', arguments: { skill_id: skillFixtureId } });
    expect(result.structuredContent).toMatchObject({ skill: { name: 'videoq-lab-3dc4072c', skills: [{ name: first.name }, { name: 'videoq-sql-3dc4072c' }] } });
    expect(bundle).toHaveBeenCalledWith('owner', skillFixtureId);
    bundle.mockRejectedValueOnce(conflict('Review and publish first.'));
    expect(await client.callTool({ name: 'get_skill', arguments: { skill_id: skillFixtureId } })).toMatchObject({ isError: true });
  } finally { await client.close(); await server.close(); }
});
