import { z } from 'zod';
import { SkillLookupError } from './skills-service';

export const MODERN_MCP_VERSION = '2026-07-28';
const prefix = 'io.modelcontextprotocol/';
const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int().safe()]), method: z.string().max(128), params: z.record(z.string(), z.unknown()).optional() }).strict();
const metaSchema = z.object({ [prefix + 'protocolVersion']: z.string(), [prefix + 'clientCapabilities']: z.record(z.string(), z.unknown()) }).loose();
type Result = { status: 200 | 400 | 404 | 405 | 429 | 500; body: Record<string, unknown> };
export interface ModernMcpDependencies {
  skills: { list(cursor?: string): Promise<unknown>; get(uri: string): Promise<unknown>; read(uri: string): Promise<unknown> };
  tools(method: 'tools/list' | 'tools/call', params: Record<string, unknown>): Promise<Record<string, unknown>>;
}
const serverMeta = { [prefix + 'serverInfo']: { name: 'videoq-api', version: '0.4.0' } };
function decodeHeader(value: string | null): string | null {
  if (!value) return value;
  if (value.startsWith('=?base64?') && value.endsWith('?=')) {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(value.slice(9, -2)), c => c.charCodeAt(0))); }
    catch { return null; }
  }
  return value;
}
export function isModernMcpRequest(body: unknown, headers: Headers): boolean {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const params = record.params && typeof record.params === 'object' ? record.params as Record<string, unknown> : {};
  const meta = params._meta && typeof params._meta === 'object' ? params._meta as Record<string, unknown> : {};
  return headers.get('MCP-Protocol-Version') === MODERN_MCP_VERSION || meta[prefix + 'protocolVersion'] !== undefined || record.method === 'server/discover' || String(record.method).startsWith('skills/');
}

export async function dispatchModernMcp(body: unknown, headers: Headers, deps: ModernMcpDependencies): Promise<Result> {
  const parsed = envelope.safeParse(body);
  const id = parsed.success ? parsed.data.id : undefined;
  const error = (code: number, message: string, status: Result['status'] = 400, data?: unknown): Result => ({ status, body: { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), error: { code, message, ...(data === undefined ? {} : { data }) } } });
  const ok = (value: unknown): Result => ({ status: 200, body: { jsonrpc: '2.0', id, result: { ...(value as Record<string, unknown>), _meta: serverMeta } } });
  if (!parsed.success) return error(-32600, 'Invalid request');
  const { method } = parsed.data;
  const params = parsed.data.params ?? {};
  const meta = metaSchema.safeParse(params._meta);
  if (!meta.success) return error(-32602, 'Required request metadata is missing');
  const version = meta.data[prefix + 'protocolVersion'];
  if (headers.get('MCP-Protocol-Version') !== version || headers.get('Mcp-Method') !== method) return error(-32020, 'Header mismatch');
  if (version !== MODERN_MCP_VERSION) return error(-32022, 'Unsupported protocol version', 400, { supported: [MODERN_MCP_VERSION] });
  if ((method === 'resources/read' && decodeHeader(headers.get('Mcp-Name')) !== params.uri) || (method === 'tools/call' && decodeHeader(headers.get('Mcp-Name')) !== params.name)) return error(-32020, 'Header mismatch');
  const capabilities = meta.data[prefix + 'clientCapabilities'] as Record<string, unknown>;
  const extensions = capabilities.extensions && typeof capabilities.extensions === 'object' ? capabilities.extensions as Record<string, unknown> : {};
  if (method.startsWith('skills/') && !extensions[prefix + 'skills']) return error(-32021, 'Skills capability required', 400, { requiredCapabilities: { extensions: { [prefix + 'skills']: {} } } });
  const cache = { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private' };
  try {
    switch (method) {
      case 'server/discover': return ok({ ...cache, supportedVersions: [MODERN_MCP_VERSION], capabilities: { tools: {}, resources: {}, extensions: { [prefix + 'skills']: {} } }, instructions: 'Discover course skills, load only the instructions needed for the task, and read cited references when needed.' });
      case 'ping': return ok({ resultType: 'complete' });
      case 'skills/list': {
        const cursor = z.string().max(1024).optional().safeParse(params.cursor);
        if (!cursor.success) return error(-32602, 'Invalid cursor');
        return ok(await deps.skills.list(cursor.data));
      }
      case 'skills/get':
      case 'resources/read': {
        if (typeof params.uri !== 'string' || params.uri.length > 2048) return error(-32602, 'Invalid resource URI');
        return ok(await (method === 'skills/get' ? deps.skills.get(params.uri) : deps.skills.read(params.uri)));
      }
      case 'resources/list': return ok({ ...cache, resources: [] });
      case 'resources/templates/list': return ok({ ...cache, resourceTemplates: [] });
      case 'tools/list':
      case 'tools/call': return ok({ ...await deps.tools(method, params), resultType: 'complete', ...(method === 'tools/list' ? { ttlMs: 60_000, cacheScope: 'private' } : {}) });
      default: return error(-32601, 'Method not found', 404);
    }
  } catch (failure) {
    if (failure instanceof SkillLookupError) return error(-32602, failure.message);
    return error(-32603, 'MCP operation failed', 500);
  }
}
