import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationCases } from '../scripts/course-skill-evaluation/cases';
import { initializeCaseRepository, writeCaseFixture } from '../scripts/course-skill-evaluation/fixtures';
import { executeComparisonSlot } from '../scripts/course-skill-evaluation/runner';
import { publicationVersionHashes } from '../scripts/course-skill-evaluation/publications';
import { readOnlySearchTransport } from '../scripts/course-skill-evaluation/environment';
import type { CohortManifest } from '../scripts/course-skill-evaluation/cohort';
import type { runCodexTrial } from '../scripts/course-skill-evaluation/codex';
import type { Bindings } from '../src/types/bindings';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../src/integrations/course-skill-publications', () => ({ createCourseSkillPublicationRepository: () => Promise.resolve({ list }) }));
const publication = { id: 'synthetic-publication', courseId: 51, skillId: 'synthetic-skill', name: 'videoq-c51-synthetic', description: 'Unit fixture only', manifest: [{ path: 'SKILL.md', digest: 'a'.repeat(64), size: 1 }] };
beforeEach(() => { list.mockReset(); list.mockResolvedValue([publication]); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function setup(run: (value: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'videoq-runner-unit-'));
  try { await run(await prepare(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
async function prepare(root: string) {
  const task = evaluationCases[0], bootstrapSource = join(root, 'bootstrap.md');
  await writeFile(bootstrapSource, '---\nname: videoq-course-skills\ndescription: Unit fixture\n---\nUse the local test server.\n');
  const base = await initializeCaseRepository(join(root, 'base'), task);
  const env = {} as Bindings;
  const manifest: CohortManifest = { version: 1, seed: 'private-unit-fixture-seed', repetitions: 2, definitionHash: 'b'.repeat(64), bootstrapHash: hash(await readFile(bootstrapSource, 'utf8')), sourceHashes: ['c'.repeat(64)], approvedSkillHashes: await publicationVersionHashes(env, 'owner', 51), executorVersion: 'unit-fixture', model: 'fixture', reasoning: 'medium', contextWindow: 32768, timeoutMs: 1000, baseCommits: { [task.id]: base } };
  const request = vi.fn<typeof fetch>();
  const createTransport = () => readOnlySearchTransport({ accountId: 'a'.repeat(32), indexName: 'unit-scenes', ownerId: 'owner', videoIds: [1], token: () => Promise.resolve('synthetic'), maxCalls: 48, fetch: request });
  return { root, task, manifest, env, bootstrapSource, request, createTransport };
}

it('prepares the same base commit and only enables each condition’s capabilities', () => setup(async f => {
  const observed: { tools: string[]; bootstrap: boolean; prompt: string }[] = [];
  const client: typeof runCodexTrial = async options => {
    observed.push({ tools: options.server?.allowedTools ?? [], bootstrap: Boolean(options.bootstrapPath), prompt: options.prompt });
    await writeCaseFixture(options.workspace, f.task.reference!);
    return { completed: true, exitCode: 0, timedOut: false, elapsedMs: 1, isolation: { config: [], discoveredCount: 0, enabled: [] }, usage: [{ input_tokens: 10, output_tokens: 2 }], answer: 'Synthetic unit result, not model evidence', events: [], logPath: 'unit-only' };
  };
  for (const condition of ['A', 'B', 'C'] as const) {
    const result = await executeComparisonSlot({ ...f, directory: f.root, ownerId: 'owner', courseId: 51, videoIds: [1], slot: { taskId: f.task.id, condition, repetition: 1, blindId: condition }, client, readExecutorVersion: () => Promise.resolve('unit-fixture') });
    expect(result).toMatchObject({ validity: 'valid', functional: true, baseCommit: f.manifest.baseCommits[f.task.id], inputTokens: 10, outputTokens: 2 });
    expect(hash(await readFile(result.detailPath, 'utf8'))).toBe(result.detailSha256);
    const detail = JSON.parse(await readFile(result.detailPath, 'utf8'));
    expect(detail.reviewFiles.files).toContainEqual({ path: 'src/main.mjs', content: f.task.reference!['src/main.mjs'] });
    expect(detail.reviewFiles.files.some((file: { path: string }) => file.path.startsWith('.agents/'))).toBe(false);
  }
  expect(observed[0]).toMatchObject({ tools: [], bootstrap: false });
  expect(observed[1].tools).toEqual(['get_course_info', 'search_scenes', 'read_video_window']);
  expect(observed[1].bootstrap).toBe(false);
  expect(observed[2].tools).toContain('read_course_skill_resource'); expect(observed[2].bootstrap).toBe(true);
  expect(new Set(observed.map(o => o.prompt)).size).toBe(1);
  expect(f.request).not.toHaveBeenCalled();
}));
it('does not run even a baseline model when the pinned publication is unavailable', () => setup(async f => {
  list.mockResolvedValue([]);
  const client = vi.fn();
  await expect(executeComparisonSlot({ ...f, directory: f.root, ownerId: 'owner', courseId: 51, videoIds: [1], slot: { taskId: f.task.id, condition: 'A', repetition: 1, blindId: 'no-publication' }, client })).rejects.toThrow('COHORT_PUBLICATION_CHANGED_OR_UNAVAILABLE');
  expect(client).not.toHaveBeenCalled();
}));
it('rejects a changed client version and does not consume a model call', () => setup(async f => {
  const client = vi.fn();
  await expect(executeComparisonSlot({ ...f, directory: f.root, ownerId: 'owner', courseId: 51, videoIds: [1], slot: { taskId: f.task.id, condition: 'B', repetition: 1, blindId: 'wrong-client' }, client, readExecutorVersion: () => Promise.resolve('different-version') })).rejects.toThrow('COHORT_EXECUTOR_VERSION_CHANGED');
  expect(client).not.toHaveBeenCalled();
}));
it('rejects modified publication metadata, not only modified file digests', () => setup(async f => {
  list.mockResolvedValue([{ ...publication, description: 'changed instructions for discovery' }]);
  const client = vi.fn();
  await expect(executeComparisonSlot({ ...f, directory: f.root, ownerId: 'owner', courseId: 51, videoIds: [1], slot: { taskId: f.task.id, condition: 'C', repetition: 1, blindId: 'changed-publication' }, client })).rejects.toThrow('COHORT_PUBLICATION_CHANGED_OR_UNAVAILABLE');
  expect(client).not.toHaveBeenCalled();
}));
