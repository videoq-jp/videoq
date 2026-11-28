import { beforeEach, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types/bindings';
import type { CourseSkillCandidate } from '../src/persistence/contracts/course-skill-candidate-repository';
const mocks = vi.hoisted(() => ({ ownedBy: vi.fn(), list: vi.fn(), reject: vi.fn(), snapshot: vi.fn(), managed: vi.fn(), progress: vi.fn(), publish: vi.fn() }));
vi.mock('../src/persistence/factory', () => ({ createCourseRepository: async () => ({ ownedBy: mocks.ownedBy }) }));
vi.mock('../src/integrations/course-skill-candidates', () => ({ createCourseSkillCandidateRepository: async () => ({ list: mocks.list, reject: mocks.reject }) }));
vi.mock('../src/integrations/course-skill-inputs', () => ({ createCourseSkillInputRepository: async () => ({ snapshot: mocks.snapshot }) }));
vi.mock('../src/integrations/course-skill-publications', () => ({ createCourseSkillPublicationRepository: async () => ({ managed: mocks.managed }), publishCourseSkillCandidate: mocks.publish }));
vi.mock('../src/integrations/course-skill-execution-repository', () => ({ createCourseSkillExecutionRepository: async () => ({ progress: mocks.progress }) }));
import { courseSkillManagement } from '../src/integrations/course-skill-management';
let candidate: CourseSkillCandidate;
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  candidate = { id: 'candidate', courseId: 1, buildId: 'build', skillId: 'skill', contentHash: 'hash', status: 'review_required', approvedHash: null, buildRevision: 1, sourceState: 'source', content: {
    task: { skillId: 'skill', slug: 'review-source', objective: 'Review source evidence', factIds: ['fact'] }, issues: [],
    draft: { slug: 'review-source', title: 'Review source evidence', description: 'Inspect source evidence', useWhen: ['Reviewing evidence'], doNotUseWhen: [], criteria: [{ decision: 'Check scope', factIds: ['fact'] }], steps: [{ action: 'Inspect', expectedResult: 'Confirmed', factIds: ['fact'] }], checks: [{ check: 'Compare', factIds: ['fact'] }], exceptions: [], examples: [] },
    facts: [{ id: 'fact', kind: 'procedure', claim: 'Fixture claim', appliesWhen: [], exceptions: [], evidence: [{ cueId: 'cue', quote: 'source text' }], requiresVisualEvidence: true, visualEvidence: [{ frameId: 'known-frame', observation: 'Visible fixture' }], versionContext: { language: null, framework: null, version: null }, status: 'supported', videoId: 42, analysisRevision: 'revision', cues: [{ id: 'cue', startMs: 1000, endMs: 2000, text: 'source text' }], frames: [{ id: 'known-frame', timestampMs: 60000 }] }],
  } };
  mocks.ownedBy.mockResolvedValue(true); mocks.list.mockResolvedValue([candidate]); mocks.reject.mockResolvedValue(true); mocks.managed.mockResolvedValue([]);
  mocks.snapshot.mockResolvedValue({ settings: { generationEnabled: true, distributionEnabled: false, language: 'ja', policyVersion: '1' }, revision: 1, sourceState: 'source', sources: [] });
  mocks.progress.mockResolvedValue([{ id: 'build', revision: 1, state: 'completed', checkpoint: '{}' }]);
});
const service = () => courseSkillManagement({} as Bindings, 'owner');
it('keeps an invalid saved candidate reviewable and rejectable without generating files or allowing publication', async () => {
  const result = await service().get(1, 'candidate');
  expect(result).toMatchObject({ draft: { title: 'Review source evidence' }, issues: ['SKILL_INVALID_VISUAL_EVIDENCE'], files: [], sources: expect.arrayContaining([expect.objectContaining({ kind: 'image', startMs: 60000 })]) });
  expect((await service().list(1)).candidates[0]).toMatchObject({ editable: true, canPublish: false, issues: ['SKILL_INVALID_VISUAL_EVIDENCE'] });
  expect(candidate.content.issues).toEqual([]);
  await expect(service().reject(1, 'candidate', 'hash')).resolves.toEqual({ success: true });
  expect(mocks.reject).toHaveBeenCalledWith('candidate', 'owner', 'hash'); expect(mocks.publish).not.toHaveBeenCalled();
});
it('preserves file previews and publication eligibility for a valid candidate', async () => {
  candidate.content.facts[0].frames![0].timestampMs = 1500;
  expect((await service().get(1, 'candidate')).files.map(file => file.path)).toEqual(['SKILL.md', 'references/sources.md']);
  expect((await service().list(1)).candidates[0]).toMatchObject({ canPublish: true, issues: [] });
});
it('returns a bounded review issue for an obsolete draft with missing fact references', async () => {
  candidate.content.facts[0].frames![0].timestampMs = 1500;
  candidate.content.draft!.checks[0].factIds = ['unknown'];
  expect(await service().get(1, 'candidate')).toMatchObject({ issues: ['SKILL_CANDIDATE_REVALIDATION_REQUIRED'], files: [] });
  expect((await service().list(1)).candidates[0].canPublish).toBe(false);
});
