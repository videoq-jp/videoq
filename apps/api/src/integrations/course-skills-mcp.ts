import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCourseSkillPublicationRepository } from './course-skill-publications';
import { createMcpSkillsService } from '../features/mcp/skills-service';
import { dispatchModernMcp } from '../features/mcp/modern-http';
import { createVideoqMcpServer } from '../features/mcp/server';
import type { ToolActorContext } from '../tools/management';
import { z } from 'zod';
import { enforceThrottles } from '../lib/rate-limit';

/** Reuse registered tool handlers so modern clients keep all legacy authorization and budgets. */
export async function dispatchCourseSkillsMcp(body: unknown, headers: Headers, ctx: ToolActorContext) {
  const request = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (['skills/list', 'skills/get', 'resources/read'].includes(String(request.method))) {
    const throttled = await enforceThrottles(ctx.env, [{ scope: 'mcp_read_user', ident: ctx.userId }]);
    if (throttled) return { status: 429 as const, body: { jsonrpc: '2.0', id: request.id, error: { code: 42901, message: 'MCP read rate limit exceeded', data: { retryAfterSeconds: throttled.retryAfterSec } } } };
  }
  const skills = createMcpSkillsService(await createCourseSkillPublicationRepository(ctx.env), ctx.userId);
  return dispatchModernMcp(body, headers, {
    skills,
    tools: async (method, params) => {
      const { CfWorkerJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/cfworker');
      const server = createVideoqMcpServer(ctx);
      const client = new Client({ name: 'videoq-stateless-adapter', version: '1' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(st); await client.connect(ct);
        if (method === 'tools/list') return await client.listTools();
        const input = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).parse(params);
        return await client.callTool(input);
      } finally { await client.close(); await server.close(); }
    },
  });
}
