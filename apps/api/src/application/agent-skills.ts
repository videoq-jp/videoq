import type { SkillDraft, SkillStage } from '@videoq/domain/agent-skills';

/** Application output data; no RPC schemas or provider SDK types. */
export type SkillMemberView = {
  objective: string; status: 'pending' | 'auditing' | 'passed' | 'rejected'; issues: string[];
  skillName: string | null; title: string | null; description: string | null;
  markdown: string | null; sourcesMarkdown: string | null;
};
export type SkillView = {
  id: string; automatic?: boolean; members?: SkillMemberView[]; stage: SkillStage;
  objective: string; language: 'ja' | 'en'; resourceTitle: string;
  completedChunks: number; totalChunks: number; sourceVideos: number; issues: string[];
  sourcesMarkdown: string | null; draft: SkillDraft | null; skillName: string | null; markdown: string | null;
};
export type SkillArtifact = { id: string; name: string; files: { 'SKILL.md': string; 'references/sources.md': string } };
export type SkillBundle = SkillArtifact & { skills?: SkillArtifact[]; nextOffset?: number | null; totalSkills?: number };
