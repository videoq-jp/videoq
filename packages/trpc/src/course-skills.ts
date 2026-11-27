import { z } from 'zod';
const id = z.number().int().positive().safe();
const text = z.string().min(1).max(2000);
const ids = z.array(z.string().min(1).max(160)).min(1).max(128);
export const courseSkillDraftSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40), title: text, description: z.string().min(1).max(1024),
  useWhen: z.array(text).min(1).max(12), doNotUseWhen: z.array(text).max(12),
  criteria: z.array(z.object({ decision: text, factIds: ids }).strict()).min(1).max(24),
  steps: z.array(z.object({ action: text, expectedResult: text, factIds: ids }).strict()).min(1).max(24),
  exceptions: z.array(z.object({ condition: text, behavior: text, factIds: ids }).strict()).max(24),
  checks: z.array(z.object({ check: text, factIds: ids }).strict()).min(1).max(24),
  examples: z.array(z.object({ situation: text, application: text, factIds: ids }).strict()).max(12),
}).strict();
const settings = z.object({ generationEnabled: z.boolean(), distributionEnabled: z.boolean(), policyVersion: z.string().min(1).max(128), language: z.enum(['ja', 'en']) });
const candidate = z.object({ courseId: id, candidateId: z.string().min(1).max(128) });
const reviewed = candidate.extend({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/) });
export const courseSkillsInputSchemas = {
  'courseSkills.list': z.object({ courseId: id }),
  'courseSkills.get': candidate,
  'courseSkills.configure': z.object({ courseId: id, settings }),
  'courseSkills.rebuild': z.object({ courseId: id }),
  'courseSkills.update': reviewed.extend({ draft: courseSkillDraftSchema }),
  'courseSkills.publish': reviewed,
  'courseSkills.reject': reviewed,
  'courseSkills.withdraw': z.object({ courseId: id, skillId: z.string().min(1).max(128) }),
};
const summary = z.object({ id: z.string(), skillId: z.string(), title: z.string(), description: z.string(), status: z.string(), contentHash: z.string(), issues: z.array(z.string()), hasDraft: z.boolean(), editable: z.boolean(), canPublish: z.boolean(),
  publication: z.object({ id: z.string(), state: z.string(), validSources: z.boolean() }).nullable() });
export const courseSkillsOutputSchemas = {
  'courseSkills.list': z.object({ settings, revision: z.number(), candidates: z.array(summary),
    jobs: z.array(z.object({ id: z.string(), revision: z.number(), state: z.string(), phase: z.string(), processedVideos: z.number(), totalVideos: z.number(), error: z.string().nullable() })) }),
  'courseSkills.get': z.object({ id: z.string(), skillId: z.string(), contentHash: z.string(), status: z.string(), issues: z.array(z.string()), draft: courseSkillDraftSchema.nullable(), previousDraft: courseSkillDraftSchema.nullable(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
    sources: z.array(z.object({ factId: z.string(), claim: z.string(), videoId: id, startMs: z.number(), endMs: z.number(), quote: z.string(), kind: z.enum(['subtitle', 'image']).optional() })) }),
  'courseSkills.configure': z.object({ success: z.literal(true) }),
  'courseSkills.rebuild': z.object({ success: z.literal(true) }),
  'courseSkills.update': z.object({ success: z.literal(true) }),
  'courseSkills.publish': z.object({ revisionId: z.string() }),
  'courseSkills.reject': z.object({ success: z.literal(true) }),
  'courseSkills.withdraw': z.object({ success: z.literal(true) }),
};
