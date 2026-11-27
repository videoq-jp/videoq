import type { CourseSkillInputRepository, CourseSkillSettings, CourseSkillSnapshot } from '../../persistence/contracts/course-skill-input-repository';

export type SkillInputDependencies = {
  repository: CourseSkillInputRepository;
  hash(value: string): Promise<string>;
  id(): string;
  now(): number;
};

export function courseSkillInputService(deps: SkillInputDependencies) {
  async function reconcile(courseId: number, ownerId: string) {
    const snapshot = await deps.repository.snapshot(courseId, ownerId);
    if (!snapshot || !snapshot.settings.generationEnabled) return { status: 'disabled' } as const;
    // The source projection is bounded metadata. Never put transcripts in a queue envelope.
    const input = JSON.stringify({ version: 1, courseId, ownerId, sourceState: snapshot.sourceState, settings: snapshot.settings, sources: snapshot.sources.filter(s => s.ready) });
    if (input.length > 256_000) throw new Error('SKILL_INPUT_TOO_LARGE');
    const ready = snapshot.sources.some(s => s.ready);
    const build = ready ? { id: deps.id(), inputKey: await deps.hash(input), input } : null;
    const applied = await deps.repository.reconcile(snapshot, build, deps.now());
    return { status: applied ? 'reconciled' : 'changed', ready } as const;
  }
  return {
    reconcile,
    async configure(courseId: number, ownerId: string, settings: CourseSkillSettings) {
      if (!settings.policyVersion.trim() || settings.policyVersion.length > 128 || !['ja', 'en'].includes(settings.language)) throw new Error('INVALID_SKILL_SETTINGS');
      if (!await deps.repository.configure(courseId, ownerId, settings)) return false;
      await reconcile(courseId, ownerId);
      return true;
    },
    async sweep(limit = 25) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_SKILL_SWEEP_LIMIT');
      const due = await deps.repository.due(deps.now(), limit);
      let reconciled = 0;
      for (const item of due) {
        const result = await reconcile(item.courseId, item.ownerId);
        if (result.status === 'reconciled') reconciled++;
      }
      return { checked: due.length, reconciled };
    },
  };
}

/** Documents the immutable source contract for downstream generation adapters. */
export type SkillGenerationInput = Pick<CourseSkillSnapshot, 'courseId' | 'ownerId' | 'settings' | 'sources'>;
