import type { SkillDraft, SkillStage, ExtractedFacts, SkillMember } from '@videoq/domain/agent-skills';
export type SkillTarget = { kind: 'course' | 'video'; resourceId: number };
export type SkillSource = { id: number; title: string; transcript: string };
export type SkillMaterial = { title: string; sources: SkillSource[] };
export type SkillCue = { id: string; videoId: number; title: string; start: string | null; end: string | null; text: string };
export type SkillFact = ExtractedFacts['facts'][number] & { id: string };
export type AgentSkillState = {
  version: 1; plannedFacts?: number; automatic?: boolean; members?: SkillMember[]; target: SkillTarget; objective: string; language: 'ja' | 'en'; resourceTitle: string;
  fingerprint: string; stage: SkillStage; chunks: SkillCue[][]; completedChunks: number;
  sourceVideos: number; facts: SkillFact[]; draft: SkillDraft | null; issues: string[];
};
export type AgentSkillRecord = { id: string; ownerId: string; state: AgentSkillState };
