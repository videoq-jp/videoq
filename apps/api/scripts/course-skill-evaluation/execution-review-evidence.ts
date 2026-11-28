import { z } from 'zod';

const executionSchema = z.object({ events: z.array(z.object({ type: z.string(), item: z.unknown().optional() })).max(5000) });
const command = z.object({ type: z.literal('command_execution'), command: z.string(), aggregated_output: z.string(), exit_code: z.number().int().nullable(), status: z.string() });
const mcp = z.object({ type: z.literal('mcp_tool_call'), tool: z.string(), arguments: z.unknown(), result: z.unknown(), error: z.unknown(), status: z.string() });

/** Retain observed evidence, but omit assigned labels, grades and reasoning. */
export function executionReviewEvidence(execution: unknown, condition: 'A' | 'B' | 'C', workspace: string) {
  const events = executionSchema.parse(execution).events;
  const operations = events.filter(e => e.type === 'item.completed').flatMap<Record<string, unknown>>(e => {
    const item = e.item as { type?: unknown } | null;
    if (item?.type === 'command_execution') {
      const c = command.parse(item);
      return [{ kind: 'command', command: c.command, output: c.aggregated_output, exitCode: c.exit_code, status: c.status }];
    }
    if (item?.type === 'mcp_tool_call') {
      const c = mcp.parse(item);
      return [{ kind: 'mcp', tool: c.tool, arguments: c.arguments, result: c.result, error: c.error, status: c.status }];
    }
    return [];
  });
  const availableMcpTools = condition === 'A' ? [] : ['get_course_info', 'search_scenes', 'read_video_window', ...(condition === 'C' ? ['list_course_skills', 'get_course_skill', 'read_course_skill_resource'] : [])];
  const raw = JSON.stringify({ availableMcpTools, operations });
  if (raw.length > 250_000) throw new Error('REVIEW_EXECUTION_EVIDENCE_TOO_LARGE');
  // Workspace identifiers otherwise allow joining an anonymous packet to logs.
  return JSON.parse(raw.replaceAll(JSON.stringify(workspace).slice(1, -1), '[workspace]')) as { availableMcpTools: string[]; operations: Record<string, unknown>[] };
}
