import type { SkillDraft } from '@videoq/domain/agent-skills';
import type { Bindings } from '../types/bindings';
import { createCourseRepository } from '../persistence/factory';
import { createCourseSkillInputRepository, createCourseSkillInputs } from './course-skill-inputs';
import { createCourseSkillCandidateRepository } from './course-skill-candidates';
import { createCourseSkillPublicationRepository, publishCourseSkillCandidate } from './course-skill-publications';
import { createCourseSkillExecutionRepository } from './course-skill-execution-repository';
import type { CourseSkillSettings } from '../persistence/contracts/course-skill-input-repository';
import { renderCourseSkill, validateSkillDraft } from '../domain/learning/course-skill-draft';
import { courseSkillDraftDependencies } from './course-skill-drafts';

export class CourseSkillManagementError extends Error {
  constructor(readonly kind: 'not_found' | 'conflict' | 'invalid', message: string) { super(message); }
}
const defaults: CourseSkillSettings = { generationEnabled: false, distributionEnabled: false, language: 'ja', policyVersion: '1' };
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('');

export function courseSkillManagement(env: Bindings, ownerId: string) {
  async function requireOwner(courseId: number) {
    if (!await (await createCourseRepository(env)).ownedBy(courseId, ownerId)) throw new CourseSkillManagementError('not_found', 'Course not found');
  }
  return {
    async list(courseId: number) {
      await requireOwner(courseId);
      const snapshot = await (await createCourseSkillInputRepository(env)).snapshot(courseId, ownerId);
      const candidates = await (await createCourseSkillCandidateRepository(env)).list(courseId, ownerId);
      const publications = await (await createCourseSkillPublicationRepository(env)).managed(courseId, ownerId);
      const builds = await (await createCourseSkillExecutionRepository(env)).progress(courseId, ownerId);
      const latest = new Map(candidates.map(c => [c.skillId, c]));
      const totalVideos = snapshot?.sources.filter(s => s.ready).length ?? 0;
      return { settings: snapshot?.settings ?? defaults, revision: snapshot?.revision ?? 0,
        candidates: [...latest.values()].map(c => ({ id: c.id, skillId: c.skillId, title: c.content.draft?.title ?? c.content.task.objective,
          description: c.content.draft?.description ?? '', status: c.status, contentHash: c.contentHash, issues: c.content.issues, hasDraft: Boolean(c.content.draft),
          editable: Boolean(snapshot?.settings.generationEnabled && c.buildRevision === snapshot.revision && c.status !== 'published' && builds.some(b => b.id === c.buildId && b.state === 'completed')),
          canPublish: Boolean(snapshot?.settings.generationEnabled && c.buildRevision === snapshot.revision && c.content.draft && !c.content.issues.length && ['review_required', 'approved'].includes(c.status) && builds.some(b => b.id === c.buildId && b.state === 'completed')),
          publication: (() => { const p = publications.find(p => p.skillId === c.skillId); return p ? { id: p.id, state: p.state, validSources: p.validSources } : null; })(),
        })),
        jobs: builds.map(b => {
          let state: { phase?: string; sourceIndex?: number; error?: string } = {};
          try { state = JSON.parse(b.checkpoint || '{}') as typeof state; } catch { state = { error: 'SKILL_INVALID_EXECUTION_INPUT' }; }
          return { id: b.id, revision: b.revision, state: snapshot && b.revision !== snapshot.revision && ['running', 'queued'].includes(b.state) ? 'superseded' : b.state,
            phase: typeof state.phase === 'string' ? state.phase : 'extracting', processedVideos: Math.min(totalVideos, Number.isSafeInteger(state.sourceIndex) ? Math.max(0, state.sourceIndex!) : 0), totalVideos,
            error: typeof state.error === 'string' && /^SKILL_[A-Z_]+$/.test(state.error) ? state.error : null };
        }),
      };
    },
    async get(courseId: number, candidateId: string) {
      await requireOwner(courseId);
      const all = await (await createCourseSkillCandidateRepository(env)).list(courseId, ownerId);
      const c = all.find(c => c.id === candidateId);
      if (!c) throw new CourseSkillManagementError('not_found', 'Skill candidate not found');
      const previous = all.filter(p => p.skillId === c.skillId && p.id !== c.id && p.status === 'published').at(-1);
      return { id: c.id, skillId: c.skillId, contentHash: c.contentHash, status: c.status, issues: c.content.issues, draft: c.content.draft, previousDraft: previous?.content.draft ?? null,
        files: c.content.draft ? renderCourseSkill(courseId, c.content.draft, c.content.facts, c.content.generation?.language).files : [],
        sources: c.content.facts.flatMap(f => [...f.evidence.map(e => { const cue = f.cues.find(c => c.id === e.cueId); return { factId: f.id, claim: f.claim, videoId: f.videoId, startMs: cue?.startMs ?? 0, endMs: cue?.endMs ?? 0, quote: e.quote, kind: 'subtitle' as const }; }), ...(f.visualEvidence ?? []).map(e => { const frame = f.frames?.find(frame => frame.id === e.frameId); return { factId: f.id, claim: f.claim, videoId: f.videoId, startMs: frame?.timestampMs ?? 0, endMs: frame?.timestampMs ?? 0, quote: e.observation, kind: 'image' as const }; })]),
      };
    },
    async configure(courseId: number, settings: CourseSkillSettings) {
      await requireOwner(courseId);
      if (!await (await createCourseSkillInputs(env)).configure(courseId, ownerId, settings)) throw new CourseSkillManagementError('not_found', 'Course not found');
      return { success: true as const };
    },
    async rebuild(courseId: number) {
      await requireOwner(courseId);
      const snapshot = await (await createCourseSkillInputRepository(env)).snapshot(courseId, ownerId);
      if (!snapshot?.settings.generationEnabled) throw new CourseSkillManagementError('invalid', 'Enable Skills generation first');
      await (await createCourseSkillInputs(env)).configure(courseId, ownerId, snapshot.settings, true);
      return { success: true as const };
    },
    async update(courseId: number, candidateId: string, expectedHash: string, draft: SkillDraft) {
      await requireOwner(courseId);
      const repository = await createCourseSkillCandidateRepository(env);
      const candidate = (await repository.list(courseId, ownerId)).find(c => c.id === candidateId);
      const snapshot = await (await createCourseSkillInputRepository(env)).snapshot(courseId, ownerId);
      const builds = await (await createCourseSkillExecutionRepository(env)).progress(courseId, ownerId);
      if (!candidate || candidate.contentHash !== expectedHash || candidate.status === 'published' || candidate.buildRevision !== snapshot?.revision || !builds.some(b => b.id === candidate.buildId && b.state === 'completed')) throw new CourseSkillManagementError('conflict', 'Skill candidate changed; reload before editing');
      if (draft.slug !== candidate.content.task.slug) throw new CourseSkillManagementError('invalid', 'Skill identity cannot be edited');
      validateSkillDraft(draft, candidate.content.facts);
      const audit = await courseSkillDraftDependencies(env, ownerId, snapshot.settings.language).audit(draft, candidate.content.facts);
      const content = { ...candidate.content, draft, issues: audit.supported ? audit.issues : [...audit.issues, 'SKILL_SEMANTIC_REVIEW_REQUIRED'] };
      if (!await repository.edit(candidateId, ownerId, expectedHash, content, await digest(JSON.stringify(content)))) throw new CourseSkillManagementError('conflict', 'Skill candidate changed; reload before editing');
      return { success: true as const };
    },
    async publish(courseId: number, candidateId: string, expectedHash: string) {
      await requireOwner(courseId);
      try { return await publishCourseSkillCandidate(env, { courseId, candidateId, expectedHash, ownerId }); }
      catch { throw new CourseSkillManagementError('conflict', 'Skill candidate or course changed; reload before publishing'); }
    },
    async withdraw(courseId: number, skillId: string) {
      await requireOwner(courseId);
      if (!await (await createCourseSkillPublicationRepository(env)).withdraw(courseId, skillId, ownerId)) throw new CourseSkillManagementError('not_found', 'Published skill not found');
      return { success: true as const };
    },
    async reject(courseId: number, candidateId: string, expectedHash: string) {
      await requireOwner(courseId);
      const repo = await createCourseSkillCandidateRepository(env);
      if (!(await repo.list(courseId, ownerId)).some(c => c.id === candidateId) || !await repo.reject(candidateId, ownerId, expectedHash)) throw new CourseSkillManagementError('conflict', 'Skill candidate changed; reload before rejecting');
      return { success: true as const };
    },
  };
}
