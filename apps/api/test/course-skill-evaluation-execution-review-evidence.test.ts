import { expect, test } from 'vitest';
import { executionReviewEvidence } from '../scripts/course-skill-evaluation/execution-review-evidence';

test('preserves observed operations and available tools without assigned labels or reasoning', () => {
  const value = executionReviewEvidence({ events: [
    { type: 'item.completed', item: { type: 'reasoning', text: 'Private reasoning' } },
    { type: 'item.started', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { id: 'hidden-operation-id', type: 'command_execution', command: 'cd /private/task && npm test', aggregated_output: '3 tests passed', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'search_scenes', arguments: { course_id: 51 }, result: { content: [] }, error: null, status: 'completed' } },
  ] }, 'B', '/private/task');
  expect(value.availableMcpTools).toEqual(['get_course_info', 'search_scenes', 'read_video_window']);
  expect(value.operations).toHaveLength(2);
  expect(value.operations[0]).toMatchObject({ command: 'cd [workspace] && npm test', output: '3 tests passed', exitCode: 0 });
  const raw = JSON.stringify(value);
  for (const text of ['Private reasoning', '/private/task', 'hidden-operation-id', 'condition', 'repetition', 'functional']) expect(raw).not.toContain(text);
  expect(executionReviewEvidence({ events: [] }, 'A', '/private/task').availableMcpTools).toEqual([]);
  expect(executionReviewEvidence({ events: [] }, 'C', '/private/task').availableMcpTools).toContain('read_course_skill_resource');
});
test('refuses missing or oversized evidence instead of fabricating or silently truncating it', () => {
  expect(() => executionReviewEvidence({}, 'A', '/private/task')).toThrow();
  expect(() => executionReviewEvidence({ events: [{ type: 'item.completed', item: { type: 'command_execution', command: 'test', aggregated_output: 'x'.repeat(250001), exit_code: 0, status: 'completed' } }] }, 'A', '/private/task')).toThrow('TOO_LARGE');
});
