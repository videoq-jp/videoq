/** Imports exact owner-reviewed artifacts into a disposable local publication fixture. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { courseSkillDraftSchema } from '@videoq/trpc/course-skills';
import { assertLocalEvaluationEnvironment, sha256, type createFrozenEvaluationEnvironment } from './environment';
import { skillTranscriptChunks, type SkillCue } from '../../src/domain/learning/skill-knowledge';
import { renderCourseSkill } from '../../src/domain/learning/course-skill-draft';
import { courseSkillManagement } from '../../src/integrations/course-skill-management';
import { createCourseSkillInputRepository } from '../../src/integrations/course-skill-inputs';
import { createCourseSkillCandidateRepository } from '../../src/integrations/course-skill-candidates';
import type { CourseSkillCandidateContent } from '../../src/persistence/contracts/course-skill-candidate-repository';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.object({ version: z.literal(1), scope: z.literal('local-evaluation-only'), status: z.literal('owner-approved'), courseId: z.number().int().positive(), ownerDecision: z.string().min(1).max(1000),
  packages: z.array(z.object({ directory: z.string().min(1), dataSha256: hex, files: z.array(z.object({ path: z.enum(['SKILL.md', 'references/sources.md']), sha256: hex }).strict()).length(2) }).strict()).min(1).max(5),
}).strict();
const cue = z.object({ id: z.string().max(64), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(), text: z.string().max(3000) }).strict();
const fact = z.object({ id: z.string().min(1).max(160), kind: z.enum(['principle', 'criterion', 'procedure', 'exception', 'verification', 'example']), claim: z.string().min(1).max(2000),
  appliesWhen: z.array(z.string().max(1000)).max(12), exceptions: z.array(z.string().max(1000)).max(12), evidence: z.array(z.object({ cueId: z.string().max(64), quote: z.string().min(1).max(3000) }).strict()).min(1).max(12),
  requiresVisualEvidence: z.literal(false), visualEvidence: z.array(z.never()).optional(), status: z.literal('supported'), videoId: z.number().int().positive(), analysisRevision: z.string().min(1).max(128), cues: z.array(cue).min(1).max(12),
  versionContext: z.object({ language: z.string().max(128).nullable(), framework: z.string().max(128).nullable(), version: z.string().max(128).nullable() }).strict(),
}).strict();
const dataSchema = z.object({ draft: courseSkillDraftSchema, facts: z.array(fact).min(1).max(40) }).strict();

/** Passive validation is allowed before the owner decision; it performs no writes. */
export async function validateReviewedArtifactPackages(fixture: Awaited<ReturnType<typeof createFrozenEvaluationEnvironment>>, packages: unknown) {
  assertLocalEvaluationEnvironment(fixture.env);
  const entries = approvalSchema.shape.packages.parse(packages);
  const originalCues = new Map<number, Map<string, SkillCue>>();
  for (const video of fixture.source.videos) {
    const all = new Map<string, SkillCue>(), chars = [...video.transcript];
    for await (const chunk of skillTranscriptChunks(offset => Promise.resolve({ text: chars.slice(offset, offset + 12000).join(''), nextOffset: Math.min(offset + 12000, chars.length), done: offset + 12000 >= chars.length }), 3000)) for (const c of chunk.cues) all.set(c.id, c);
    originalCues.set(video.id, all);
  }
  const reviewed: { content: CourseSkillCandidateContent; contentHash: string; name: string }[] = [];
  for (const entry of entries) {
    const raw = await readFile(join(entry.directory, 'review-data.json'), 'utf8');
    if (Buffer.byteLength(raw) > 240_000 || await sha256(raw) !== entry.dataSha256) throw new Error('REVIEWED_DATA_CHANGED');
    const data = dataSchema.parse(JSON.parse(raw));
    for (const item of data.facts) {
      const current = originalCues.get(item.videoId);
      if (fixture.revisions.get(item.videoId) !== item.analysisRevision || !current || item.cues.some(c => { const original = current.get(c.id); return !original || original.startMs !== c.startMs || original.endMs !== c.endMs || original.text !== c.text; }) || item.evidence.some(e => current.get(e.cueId)?.text !== e.quote || !item.cues.some(c => c.id === e.cueId))) throw new Error('REVIEWED_SOURCE_CHANGED');
    }
    const rendered = renderCourseSkill(fixture.source.courseId, data.draft, data.facts, 'ja');
    if (new Set(entry.files.map(f => f.path)).size !== 2) throw new Error('REVIEWED_FILES_INCOMPLETE');
    for (const file of entry.files) {
      const original = await readFile(join(entry.directory, file.path), 'utf8');
      if (await sha256(original) !== file.sha256 || rendered.files.find(f => f.path === file.path)?.content !== original) throw new Error('REVIEWED_FILES_CHANGED');
    }
    const skillId = crypto.randomUUID();
    const content: CourseSkillCandidateContent = { task: { skillId, slug: data.draft.slug, objective: data.draft.description, factIds: data.facts.map(f => f.id) }, draft: data.draft, facts: data.facts, issues: [],
      generation: { knowledgeModels: ['owner-reviewed-artifact'], knowledgePromptVersions: ['reviewed-artifact-import-v1'], draftPromptVersion: 'reviewed-artifact-import-v1', language: 'ja', epoch: 0 } };
    reviewed.push({ content, contentHash: await sha256(JSON.stringify(content)), name: rendered.name });
  }
  if (new Set(reviewed.map(r => r.name)).size !== reviewed.length) throw new Error('DUPLICATE_REVIEWED_SKILL');
  return reviewed;
}

export async function importOwnerReviewedPackages(fixture: Awaited<ReturnType<typeof createFrozenEvaluationEnvironment>>, approval: unknown) {
  assertLocalEvaluationEnvironment(fixture.env);
  const parsed = approvalSchema.safeParse(approval);
  if (!parsed.success) throw new Error('OWNER_REVIEW_DECISION_REQUIRED');
  if (parsed.data.courseId !== fixture.source.courseId) throw new Error('REVIEWED_COURSE_MISMATCH');
  const reviewed = await validateReviewedArtifactPackages(fixture, parsed.data.packages);
  // Verify all packages before creating any candidate or publication.
  const owner = courseSkillManagement(fixture.env, fixture.ownerId), courseId = fixture.source.courseId;
  await owner.configure(courseId, { generationEnabled: true, distributionEnabled: true, language: 'ja', policyVersion: '1' });
  const inputs = await createCourseSkillInputRepository(fixture.env), state = await owner.list(courseId);
  const token = crypto.randomUUID(), now = Date.now();
  const build = await inputs.claim(state.jobs[0].id, fixture.ownerId, token, now, 900_000);
  if (!build) throw new Error('REVIEWED_IMPORT_BUILD_UNAVAILABLE');
  const snapshot = await inputs.snapshot(courseId, fixture.ownerId);
  const lease = { id: build.id, ownerId: fixture.ownerId, token, generation: build.generation };
  const candidates = await createCourseSkillCandidateRepository(fixture.env), ids: string[] = [];
  for (const item of reviewed) {
    item.content.generation!.epoch = snapshot!.generationEpoch;
    item.contentHash = await sha256(JSON.stringify(item.content));
    const id = crypto.randomUUID();
    if (!await candidates.save(lease, { id, content: item.content, contentHash: item.contentHash }, Date.now())) throw new Error('REVIEWED_IMPORT_CANDIDATE_FAILED');
    ids.push(id);
  }
  if (!await inputs.checkpoint(build.id, fixture.ownerId, token, build.generation, JSON.stringify({ version: 1, phase: 'review_required', sourceIndex: fixture.source.videos.length, knowledgeKeys: [], attempts: 0, modelCalls: 0 }), Date.now()) || !await inputs.complete(build.id, fixture.ownerId, token, build.generation, Date.now())) throw new Error('REVIEWED_IMPORT_INPUT_CHANGED');
  const published: string[] = [];
  try {
    for (const [index, id] of ids.entries()) { await owner.publish(courseId, id, reviewed[index].contentHash); published.push(reviewed[index].content.task.skillId); }
  } catch (error) { await Promise.allSettled(published.map(id => owner.withdraw(courseId, id))); throw error; }
  return { published: published.length, ownerDecision: parsed.data.ownerDecision, names: reviewed.map(r => r.name) };
}
