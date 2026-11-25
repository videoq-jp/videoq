/** Framework-independent generated knowledge and source evidence contracts. */
export type SkillStage = 'extracting' | 'planning' | 'synthesizing' | 'auditing' | 'review' | 'published' | 'rejected';
export type SkillEvidence = { cueId: string; quote: string };
export type ExtractedFacts = { facts: { kind: 'principle' | 'procedure' | 'exception' | 'example' | 'verification'; claim: string; appliesWhen: string; evidence: SkillEvidence[] }[] };
export type SkillDraft = {
  slug: string; title: string; description: string; useWhen: string[]; doNotUseWhen: string[];
  criteria: { decision: string; factIds: string[] }[];
  steps: { action: string; expectedResult: string; factIds: string[] }[];
  exceptions: { condition: string; behavior: string; factIds: string[] }[];
  checks: { check: string; factIds: string[] }[];
  examples: { situation: string; application: string; factIds: string[] }[];
};

/** A course is partitioned by reusable task, not by video/chapter boundaries. */
export type SkillPlan = { skills: { objective: string; factIds: string[] }[] };
export type SkillMember = { key?: string; auditCursor?: number; objective: string; factIds: string[]; draft: SkillDraft | null; attempts?: number; status: 'pending' | 'auditing' | 'passed' | 'rejected'; issues: string[] };
