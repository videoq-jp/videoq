import { z } from 'zod';
import type { Bindings } from '../types/bindings';
import { createCourseSkillInputRepository } from './course-skill-inputs';
import { createCourseSkillExecutionRepository } from './course-skill-execution-repository';
import { runCourseSkillBuild, SkillStepBudgetExceeded } from '../features/course-skills/execution-service';
import { extractCourseSkillKnowledge } from './course-skill-knowledge';
import { generateAndSaveCourseSkillCandidates } from './course-skill-candidates';
import { generateCourseSkillJson } from './course-skill-model';
import { SkillDraftRepairFailed } from '../features/course-skills/draft-service';

const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
/** At most one paid model invocation per maintenance tick; persisted steps replay without a provider call. */
export async function executeNextCourseSkillBuild(env: Bindings) {
  const inputs = await createCourseSkillInputRepository(env);
  const execution = await createCourseSkillExecutionRepository(env);
  return runCourseSkillBuild({
    inputs, execution, id: () => crypto.randomUUID(), now: () => Date.now(),
    extract: (lease, input, source, budget) => extractCourseSkillKnowledge(env, {
      lease, source, language: input.settings.language, policyVersion: input.settings.policyVersion, maxModelCalls: 1,
      beforeModel: async () => {
        if (budget.spent >= budget.maximum) throw new SkillStepBudgetExceeded();
        if (!await execution.current(lease, Date.now())) throw new Error('SKILL_INPUT_CHANGED');
        budget.spent++;
      },
    }),
    draft: async (lease, input, keys, budget) => {
      const generate: typeof generateCourseSkillJson = async (bindings, ownerId, options) => {
        const key = await digest(JSON.stringify({ build: lease.id, model: env.LLM_MODEL, name: options.name, system: options.system, input: options.input, schema: z.toJSONSchema(options.schema) }));
        const cached = await execution.readStep(lease, key, Date.now());
        if (cached) {
          const value: unknown = JSON.parse(cached);
          if (options.name === 'skill_draft_revision' && typeof value === 'object' && value !== null && '__videoqSkillRevisionFailure' in value && value.__videoqSkillRevisionFailure === true) throw new SkillDraftRepairFailed();
          return options.schema.parse(value);
        }
        if (budget.spent >= budget.maximum) throw new SkillStepBudgetExceeded();
        if (!await execution.current(lease, Date.now())) throw new Error('SKILL_INPUT_CHANGED');
        budget.spent++;
        let result: z.output<typeof options.schema>;
        try { result = await generateCourseSkillJson(bindings, ownerId, options); }
        catch (error) {
          if (options.name !== 'skill_draft_revision' || !(error instanceof Error) || !['SKILL_MODEL_GENERATION_FAILED', 'SKILL_MODEL_INPUT_TOO_LARGE'].includes(error.message)) throw error;
          if (!await execution.saveStep(lease, key, JSON.stringify({ __videoqSkillRevisionFailure: true }), Date.now())) throw new Error('SKILL_INPUT_CHANGED', { cause: error });
          throw new SkillDraftRepairFailed({ cause: error });
        }
        if (!await execution.saveStep(lease, key, JSON.stringify(result), Date.now())) throw new Error('SKILL_INPUT_CHANGED');
        return result;
      };
      await generateAndSaveCourseSkillCandidates(env, { lease, courseId: input.courseId, language: input.settings.language, generationEpoch: input.generationEpoch, knowledgeKeys: keys }, generate);
    },
  });
}
