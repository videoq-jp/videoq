import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOnlySearchTransport, createFrozenEvaluationEnvironment, sha256 } from '../scripts/course-skill-evaluation/environment';
import { importOwnerReviewedPackages, validateReviewedArtifactPackages } from '../scripts/course-skill-evaluation/reviewed-import';
import { renderCourseSkill, type SupportedSkillFact } from '../src/domain/learning/course-skill-draft';
import { embeddingIdentity, embeddingFingerprint } from '../src/lib/embedding-contract';
import { createCourseSkillPublicationRepository } from '../src/integrations/course-skill-publications';
import { createMcpSkillsService } from '../src/features/mcp/skills-service';
import type { SkillDraft } from '@videoq/domain/agent-skills';
import { publicationVersionHashes } from '../scripts/course-skill-evaluation/publications';

async function fixture(test: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await test(f); } finally { await f.local.dispose(); await rm(f.root, { recursive: true, force: true }); }
}
async function setup(persistent = false) {
  const root = await mkdtemp(join(tmpdir(), 'videoq-reviewed-import-unit-'));
  const text = 'Use fixed inputs, replace variable behavior and verify consistent results.';
  const transcript = `1\n00:00:01,000 --> 00:00:04,000\n${text}`;
  const config = { provider: 'workers-ai', model: '@cf/google/embeddinggemma-2', profile: 'embeddinggemma2' } as const;
  const request = vi.fn<typeof fetch>();
  const transport = readOnlySearchTransport({ accountId: 'a'.repeat(32), indexName: 'unit-index', ownerId: 'owner', videoIds: [1], token: () => Promise.resolve('synthetic'), maxCalls: 2, fetch: request });
  const source = { courseId: 51, videos: [{ id: 1, title: 'Synthetic lecture', transcript, user_id: 'owner', status: 'completed', revision: 'original-revision' }],
    runs: [{ id: 'synthetic-run', video_id: 1, user_id: 'owner', source_revision: 'original-revision', dimensions: 768, embedding_identity: embeddingIdentity(config), embedding_fingerprint: await embeddingFingerprint(config), expected_scenes: 0, status: 'published' }], scenes: [] };
  const persistence = persistent ? { directory: join(root, 'database') } : {};
  const local = await createFrozenEvaluationEnvironment(source, transport, persistence);
  const facts = ['principle', 'procedure', 'verification'].map((kind, index) => ({ id: `fact-${index}`, kind, claim: text, appliesWhen: [], exceptions: [], evidence: [{ cueId: 'cue-0', quote: text }], requiresVisualEvidence: false, versionContext: { language: null, framework: null, version: null }, status: 'supported', videoId: 1, analysisRevision: local.revisions.get(1)!, cues: [{ id: 'cue-0', startMs: 1000, endMs: 4000, text }] })) as SupportedSkillFact[];
  const draft: SkillDraft = { slug: 'unit-workflow', title: 'Synthetic workflow', description: 'Unit fixture only.', useWhen: ['Testing a synthetic input'], doNotUseWhen: [], criteria: [{ decision: 'Use fixed inputs', factIds: ['fact-0'] }], steps: [{ action: 'Replace variable behavior', expectedResult: 'Stable behavior', factIds: ['fact-1'] }], exceptions: [], checks: [{ check: 'Verify consistent results', factIds: ['fact-2'] }], examples: [] };
  const directory = join(root, 'package'); await mkdir(join(directory, 'references'), { recursive: true });
  const data = JSON.stringify({ draft, facts }); await writeFile(join(directory, 'review-data.json'), data, { mode: 0o600 });
  const rendered = renderCourseSkill(51, draft, facts, 'ja');
  const files = [];
  for (const file of rendered.files) { await writeFile(join(directory, file.path), file.content, { mode: 0o600 }); files.push({ path: file.path, sha256: await sha256(file.content) }); }
  const approval = { version: 1, scope: 'local-evaluation-only', status: 'owner-approved', courseId: 51, ownerDecision: 'Synthetic fixture owner action; not real-course approval', packages: [{ directory, dataSha256: await sha256(data), files }] };
  return { root, local, request, approval, directory, rendered, source, transport, persistence };
}

it('publishes only byte-identical reviewed files and preserves live removal/re-addition fences', () => fixture(async f => {
  expect(await importOwnerReviewedPackages(f.local, f.approval)).toMatchObject({ published: 1 });
  const repository = await createCourseSkillPublicationRepository(f.local.env), service = createMcpSkillsService(repository, 'owner');
  const [entry] = (await service.list()).skills;
  expect((await service.read(entry.uri)).contents[0].text).toBe(f.rendered.files[0].content);
  await f.local.env.DB!.prepare('DELETE FROM video_course_members WHERE course_id=51 AND video_id=1').run();
  expect((await service.list()).skills).toHaveLength(0);
  await expect(service.read(entry.uri)).rejects.toThrow('Unknown skill or file');
  await f.local.env.DB!.prepare('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(51,1,?,0)').bind('2026-11-27').run();
  await expect(service.read(entry.uri)).rejects.toThrow('Unknown skill or file');
  expect(f.request).not.toHaveBeenCalled();
}));
it('does not create build state from a pending or missing owner decision', () => fixture(async f => {
  await expect(importOwnerReviewedPackages(f.local, { ...f.approval, status: 'pending' })).rejects.toThrow('OWNER_REVIEW_DECISION_REQUIRED');
  expect(await f.local.env.DB!.prepare('SELECT count(*) AS count FROM course_skill_inputs').first('count')).toBe(0);
  expect(f.request).not.toHaveBeenCalled();
}));
it('rejects changed source facts even if an operator updates the file digest', () => fixture(async f => {
  const path = join(f.directory, 'review-data.json');
  const data = JSON.parse(await readFile(path, 'utf8')); data.facts[0].evidence[0].quote = 'An invented quotation';
  const raw = JSON.stringify(data); await writeFile(path, raw);
  f.approval.packages[0].dataSha256 = await sha256(raw);
  await expect(importOwnerReviewedPackages(f.local, f.approval)).rejects.toThrow('REVIEWED_SOURCE_CHANGED');
  expect(await f.local.env.DB!.prepare('SELECT count(*) AS count FROM course_skill_inputs').first('count')).toBe(0);
}));
it('rejects modified rendered files before creating any publication', () => fixture(async f => {
  await writeFile(join(f.directory, 'SKILL.md'), 'Changed after review');
  await expect(importOwnerReviewedPackages(f.local, f.approval)).rejects.toThrow('REVIEWED_FILES_CHANGED');
  expect(await f.local.env.DB!.prepare('SELECT count(*) AS count FROM course_skill_publications').first('count')).toBe(0);
}));
it('cannot be pointed at an arbitrary application environment', () => fixture(async f => {
  await expect(importOwnerReviewedPackages({ ...f.local, env: {} as typeof f.local.env }, f.approval)).rejects.toThrow('LOCAL_EVALUATION_ENVIRONMENT_REQUIRED');
}));
it('can validate the reviewable artifacts without claiming approval or creating publication state', () => fixture(async f => {
  expect(await validateReviewedArtifactPackages(f.local, f.approval.packages)).toHaveLength(1);
  expect(await f.local.env.DB!.prepare('SELECT count(*) AS count FROM course_skill_inputs').first('count')).toBe(0);
  expect(await f.local.env.DB!.prepare('SELECT count(*) AS count FROM course_skill_publications').first('count')).toBe(0);
  expect(f.request).not.toHaveBeenCalled();
}));

it('reopens an approved synthetic publication with identical URI, bytes and version hash', async () => {
  const f = await setup(true);
  let active = f.local;
  try {
    await importOwnerReviewedPackages(active, f.approval);
    const before = await publicationVersionHashes(active.env, active.ownerId, 51);
    const firstService = createMcpSkillsService(await createCourseSkillPublicationRepository(active.env), active.ownerId);
    const [entry] = (await firstService.list()).skills;
    const content = await firstService.read(entry.uri);
    await active.dispose();
    active = await createFrozenEvaluationEnvironment(f.source, f.transport, f.persistence);
    expect(active.resumed).toBe(true);
    expect(await publicationVersionHashes(active.env, active.ownerId, 51)).toEqual(before);
    const service = createMcpSkillsService(await createCourseSkillPublicationRepository(active.env), active.ownerId);
    expect((await service.list()).skills[0].uri).toBe(entry.uri);
    expect(await service.read(entry.uri)).toEqual(content);
    expect(f.request).not.toHaveBeenCalled();
  } finally { await active.dispose(); await rm(f.root, { recursive: true, force: true }); }
});
