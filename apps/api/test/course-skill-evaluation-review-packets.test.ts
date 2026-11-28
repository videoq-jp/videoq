import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationCases } from '../scripts/course-skill-evaluation/cases';
import { runComparisonCohort, type CohortManifest } from '../scripts/course-skill-evaluation/cohort';
import { captureReviewFiles } from '../scripts/course-skill-evaluation/fixtures';
import { exportReviewPackets } from '../scripts/course-skill-evaluation/review-packets';

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'videoq-review-packet-unit-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function cohort(directory: string, maxTrials = 60) {
  const manifest: CohortManifest = { version: 1, seed: 'synthetic-review-packet-seed', repetitions: 2, definitionHash: hash(evaluationCases), bootstrapHash: 'a'.repeat(64), sourceHashes: ['b'.repeat(64)], approvedSkillHashes: ['c'.repeat(64)], executorVersion: 'synthetic', model: 'synthetic', reasoning: 'medium', contextWindow: 32768, timeoutMs: 1000, baseCommits: Object.fromEntries(evaluationCases.map(c => [c.id, '1'.repeat(40)])) };
  return runComparisonCohort({ directory, manifest, cases: evaluationCases, maxTrials, verifyInputs: async () => undefined, run: async slot => {
    const detailPath = join(directory, `${slot.blindId}.json`), raw = JSON.stringify({ slot, grade: { functional: true }, execution: { answer: 'Synthetic answer with preserved citation', events: ['private-event'], logPath: '/private/log' }, reviewFiles: { files: [{ path: 'src/main.mjs', content: '// synthetic result' }], omitted: [] } });
    await writeFile(detailPath, raw, { mode: 0o600 });
    return { validity: 'valid', functional: true, elapsedMs: 1, inputTokens: 1, outputTokens: 1, detailPath, detailSha256: hash(raw), baseCommit: '1'.repeat(40) };
  } });
}
test('freezes source and tests while excluding bootstrap instructions, binaries and symlinks', () => fixture(async root => {
  await mkdir(join(root, 'src')); await mkdir(join(root, '.agents'));
  await writeFile(join(root, 'src/main.mjs'), 'export const result=1;');
  await writeFile(join(root, '.agents/SKILL.md'), 'private bootstrap');
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await symlink('/etc/passwd', join(root, 'outside-link'));
  const snapshot = await captureReviewFiles(root);
  expect(snapshot.files).toEqual([{ path: 'src/main.mjs', content: 'export const result=1;' }]);
  expect(snapshot.omitted.sort()).toEqual(['binary.dat', 'outside-link']);
}));
test('exports only masked review content and keeps scoring uncompleted', () => fixture(async root => {
  await cohort(root);
  const output = join(root, 'export');
  expect(await exportReviewPackets({ directory: root, output, cases: evaluationCases })).toEqual({ packets: 60, humanAssessmentCompleted: false });
  const raw = await readFile(join(output, 'reviewer/packets.json'), 'utf8'), packets = JSON.parse(raw);
  expect(packets.packets).toHaveLength(60);
  expect(packets.humanAssessmentCompleted).toBe(false);
  for (const field of ['condition', 'repetition', 'functional', 'events', 'logPath']) expect(raw).not.toContain(`"${field}":`);
  expect(packets.packets[0].answer).toContain('preserved citation');
  const template = JSON.parse(await readFile(join(output, 'reviewer/assessment-template.json'), 'utf8'));
  expect(template.packetHash).toBe(hash(raw));
  expect(template.assessments.every((a: { misapplied: unknown; unsupportedClaim: unknown }) => a.misapplied === null && a.unsupportedClaim === null)).toBe(true);
  const key = JSON.parse(await readFile(join(output, 'operator-key.json'), 'utf8'));
  expect(key.trials.every((t: { condition: string }) => ['A', 'B', 'C'].includes(t.condition))).toBe(true);
  await expect(exportReviewPackets({ directory: root, output, cases: evaluationCases })).rejects.toThrow();
}));
test('refuses incomplete execution and changed detailed results', () => fixture(async root => {
  const state = await cohort(root, 1);
  await expect(exportReviewPackets({ directory: root, output: join(root, 'export'), cases: evaluationCases })).rejects.toThrow('COMPLETE_EXECUTION');
  const complete = await cohort(root);
  expect(complete.results).toHaveLength(60);
  await writeFile(state.results[0].outcome.detailPath, '{"changed":true}');
  await expect(exportReviewPackets({ directory: root, output: join(root, 'export'), cases: evaluationCases })).rejects.toThrow('DETAIL_CHANGED');
}));
test('refuses changed task definitions even if IDs still match', () => fixture(async root => {
  await cohort(root);
  const changed = evaluationCases.map((task, index) => index ? task : { ...task, prompt: 'Changed evaluation question' });
  await expect(exportReviewPackets({ directory: root, output: join(root, 'export'), cases: changed })).rejects.toThrow('DEFINITION_CHANGED');
}));
