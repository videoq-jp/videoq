import type { SkillDraft as DomainSkillDraft, ExtractedFacts as DomainExtractedFacts, SkillAudit as DomainSkillAudit, SkillPlan as DomainSkillPlan } from '@videoq/domain/agent-skills';
import { z } from 'zod';

const text = z.string().trim().min(1).max(1200);
const evidence = z.object({ cueId: z.string().min(1).max(80), quote: z.string().min(4).max(800) });
export const extractedFactsSchema = z.object({ facts: z.array(z.object({
  kind: z.enum(['principle', 'procedure', 'exception', 'example', 'verification']),
  claim: text, appliesWhen: text, evidence: z.array(evidence).min(1).max(3),
})).max(12) }) satisfies z.ZodType<DomainExtractedFacts>;
const factIds = z.array(z.string().min(1).max(80)).min(1).max(8);
export const skillDraftSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(36),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(20).max(600),
  useWhen: z.array(text).min(1).max(5),
  doNotUseWhen: z.array(text).min(1).max(5),
  criteria: z.array(z.object({ decision: text, factIds })).min(1).max(10),
  steps: z.array(z.object({ action: text, expectedResult: text, factIds })).min(1).max(8),
  exceptions: z.array(z.object({ condition: text, behavior: text, factIds })).max(6),
  checks: z.array(z.object({ check: text, factIds })).min(1).max(6),
  examples: z.array(z.object({ situation: text, application: text, factIds })).max(4),
}) satisfies z.ZodType<DomainSkillDraft>;
export const skillAuditSchema = z.object({
  routingAppropriate: z.boolean(),
  checks: z.array(z.object({ claimId: z.string().max(80), grounded: z.boolean(), actionable: z.boolean(), reason: text })).min(1).max(40),
}) satisfies z.ZodType<DomainSkillAudit>;
export type SkillDraft = z.infer<typeof skillDraftSchema>;
export type ExtractedFacts = z.infer<typeof extractedFactsSchema>;
export type SkillAudit = z.infer<typeof skillAuditSchema>;
export const skillPlanSchema = z.object({ skills: z.array(z.object({
  objective: z.string().trim().min(5).max(500), factIds: z.array(z.string().min(1).max(80)).min(1).max(80),
})).min(1).max(12) }) satisfies z.ZodType<DomainSkillPlan>;
export type SkillPlan = z.infer<typeof skillPlanSchema>;
export const skillMemberViewSchema = z.object({
  objective: z.string(), status: z.enum(['pending', 'auditing', 'passed', 'rejected']), issues: z.array(z.string()),
  skillName: z.string().nullable(), title: z.string().nullable(), description: z.string().nullable(),
  markdown: z.string().nullable(), sourcesMarkdown: z.string().nullable(),
});
export const skillTargetSchema = z.object({ kind: z.enum(['course', 'video']), resourceId: z.number().int().positive().safe() });
export const skillStageSchema = z.enum(['extracting', 'planning', 'synthesizing', 'auditing', 'review', 'published', 'rejected']);
export const skillViewSchema = z.object({
  id: z.uuid(), automatic: z.boolean().optional(), members: z.array(skillMemberViewSchema).optional(), stage: skillStageSchema, objective: z.string(), language: z.enum(['ja', 'en']),
  resourceTitle: z.string(), completedChunks: z.number().int(), totalChunks: z.number().int(),
  sourceVideos: z.number().int(), issues: z.array(z.string()), sourcesMarkdown: z.string().nullable(), draft: skillDraftSchema.nullable(),
  skillName: z.string().nullable(), markdown: z.string().nullable(),
});
export type SkillView = z.infer<typeof skillViewSchema>;
const skillArtifactSchema = z.object({
  id: z.uuid(), name: z.string().regex(/^[a-z0-9-]{1,63}$/),
  files: z.object({ 'SKILL.md': z.string().min(1).max(80_000), 'references/sources.md': z.string().min(1).max(250_000) }),
});
// The first artifact stays at the root for older single-skill consumers.
export const skillBundleSchema = skillArtifactSchema.extend({ skills: z.array(skillArtifactSchema).min(1).optional(), nextOffset: z.number().int().nonnegative().nullable().optional(), totalSkills: z.number().int().positive().optional() });
export type SkillBundle = z.infer<typeof skillBundleSchema>;
export const skillInputSchemas = {
  'skills.start': skillTargetSchema.extend({ objective: z.string().trim().min(5).max(500).optional(), language: z.enum(['ja', 'en']) }),
  'skills.advance': z.object({ id: z.uuid() }),
  'skills.get': z.object({ id: z.uuid() }),
  'skills.publish': z.object({ id: z.uuid() }),
};
export const skillOutputSchemas = {
  'skills.start': skillViewSchema, 'skills.advance': skillViewSchema,
  'skills.get': skillViewSchema, 'skills.publish': skillViewSchema,
};
