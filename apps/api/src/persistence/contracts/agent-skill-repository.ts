import type { AgentSkillRecord, AgentSkillState, SkillSource } from '../../domain/skills/model';
export type { SkillTarget, SkillSource, SkillMaterial, SkillCue, SkillFact, AgentSkillState, AgentSkillRecord } from '../../domain/skills/model';
export interface AgentSkillRepository {
  sources(ownerId: string, ids: number[]): Promise<(SkillSource & { status: string })[]>;
  create(record: AgentSkillRecord): Promise<void>;
  get(id: string, ownerId: string): Promise<AgentSkillRecord | null>;
  claim(id: string, ownerId: string, token: string, now: number, expiresAt: number): Promise<boolean>;
  save(id: string, ownerId: string, token: string, state: AgentSkillState): Promise<boolean>;
  release(id: string, ownerId: string, token: string): Promise<void>;
}
