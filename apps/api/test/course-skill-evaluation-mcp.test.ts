import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { startEvaluationMcp } from '../scripts/course-skill-evaluation/mcp-server';
import { createD1Fixture } from './persistence/d1-fixture';
import type { Bindings } from '../src/types/bindings';

it('exposes only search tools and enforces authentication, course scope and a per-trial budget', async () => {
  const server = await startEvaluationMcp({ env: {} as Bindings, ownerId: 'owner', courseId: 51, mode: 'search', maxToolCalls: 1 });
  const client = new Client({ name: 'evaluation-test', version: '1' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  try {
    expect((await fetch(server.url, { method: 'POST' })).status).toBe(401);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${server.bearer}` } } }));
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['get_course_info', 'read_video_window', 'search_scenes']);
    const args = { course_id: 52, query: 'testing', video_ids: null };
    expect(await client.callTool({ name: 'search_scenes', arguments: args })).toMatchObject({ isError: true, structuredContent: { code: 'NOT_FOUND' } });
    expect(await client.callTool({ name: 'search_scenes', arguments: { ...args, course_id: 51 } })).toMatchObject({ isError: true, structuredContent: { code: 'EVALUATION_TOOL_BUDGET' } });
    expect(server.calls).toHaveLength(1);
  } finally { await client.close(); await server.close(); }
});

it('refuses a Skill comparison condition when no accessible publication exists', async () => {
  const fixture = await createD1Fixture();
  try {
    const env = { DB: fixture.database, PERSISTENCE_BACKEND: 'd1' } as Bindings;
    await expect(startEvaluationMcp({ env, ownerId: 'owner', courseId: 51, mode: 'skills' })).rejects.toThrow('APPROVED_SKILLS_NOT_AVAILABLE');
  } finally { await fixture.dispose(); }
});
