import type { AgentSkillState } from './contracts/agent-skill-repository';

export type SkillStatePointer = { storage: 'parts-v1'; revision: string; count: number; pending?: true };
export type StoredSkillState = AgentSkillState | SkillStatePointer;
export const isSkillStatePointer = (state: StoredSkillState): state is SkillStatePointer => 'storage' in state;

/** Keep individual UTF-8 SQL values well below D1's row limit. */
export function encodeSkillState(state: AgentSkillState, revision: string) {
  const text = JSON.stringify(state), parts: string[] = [];
  if (text.length <= 64_000) return { state: state as StoredSkillState, parts };
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 64_000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(start, end)); start = end;
  }
  return { state: { storage: 'parts-v1', revision, count: parts.length } as StoredSkillState, parts };
}
export function decodeSkillParts(pointer: SkillStatePointer, rows: { part: number; content: string }[]): AgentSkillState | null {
  if (pointer.pending) return null;
  if (rows.length !== pointer.count || rows.some((row, index) => row.part !== index)) return null;
  return JSON.parse(rows.map(row => row.content).join('')) as AgentSkillState;
}
