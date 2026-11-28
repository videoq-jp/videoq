/** Per-trial, loopback-only MCP with the same read tool definitions as VideoQ. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createExternalEvidenceTools } from '../../src/features/mcp/evidence-tools';
import { createCourseSkillTools } from '../../src/features/mcp/course-skill-tools';
import { createMcpSkillsService } from '../../src/features/mcp/skills-service';
import { createCourseSkillPublicationRepository } from '../../src/integrations/course-skill-publications';
import { registerTools } from '../../src/tools/mcp';
import { ToolError } from '../../src/tools/errors';
import type { Bindings } from '../../src/types/bindings';

export async function startEvaluationMcp(options: { env: Bindings; ownerId: string; courseId: number; mode: 'search' | 'skills'; maxToolCalls?: number }) {
  const maxToolCalls = options.maxToolCalls ?? 24;
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 50) throw new Error('INVALID_EVALUATION_TOOL_BUDGET');
  if (options.mode === 'skills') {
    const current = await createMcpSkillsService(await createCourseSkillPublicationRepository(options.env), options.ownerId).list();
    if (!current.skills.some(s => s.uri.startsWith(`skill://videoq/courses/${options.courseId}/`))) throw new Error('APPROVED_SKILLS_NOT_AVAILABLE');
  }
  const allowed = new Set(['get_course_info', 'search_scenes', 'read_video_window', ...(options.mode === 'skills' ? ['list_course_skills', 'get_course_skill', 'read_course_skill_resource'] : [])]);
  const calls: { name: string; success: boolean; durationMs: number }[] = [];
  const bearer = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${bearer}`);
  const active = new Set<McpServer>();
  let closed = false;
  const http = createServer((request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? '');
    if (request.url !== '/mcp' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) { response.writeHead(401).end(); return; }
    if (closed) { response.writeHead(503).end(); return; }
    const serve = async () => {
      const context = { env: options.env, userId: options.ownerId, canWrite: false };
      const definitions = [...createExternalEvidenceTools(context), ...createCourseSkillTools(context)].filter(d => allowed.has(d.name));
      const server = new McpServer({ name: 'videoq-evaluation', version: '1' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      registerTools(server, definitions.map(definition => ({ ...definition, invoke: async (input, execution) => {
        const start = Date.now();
        if (calls.length >= maxToolCalls) throw new ToolError('Evaluation tool budget exhausted.', { code: 'EVALUATION_TOOL_BUDGET', status: 429 });
        const record = { name: definition.name, success: false, durationMs: 0 }; calls.push(record);
        try {
          if (['get_course_info', 'search_scenes', 'read_video_window'].includes(definition.name) && (input as { course_id?: number }).course_id !== options.courseId) throw new ToolError('Course unavailable.', { code: 'NOT_FOUND', status: 404 });
          const result = await definition.invoke(input, execution); record.success = true; return result;
        } finally { record.durationMs = Date.now() - start; }
      } })));
      active.add(server);
      response.once('close', () => { void server.close().finally(() => active.delete(server)).catch(() => undefined); });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    };
    void serve().catch(() => { if (!response.headersSent) response.writeHead(500).end(); else response.end(); });
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('EVALUATION_LISTEN_FAILED');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, bearer, allowedTools: [...allowed], calls,
    async close() {
      closed = true;
      await Promise.allSettled([...active].map(server => server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    },
  };
}
