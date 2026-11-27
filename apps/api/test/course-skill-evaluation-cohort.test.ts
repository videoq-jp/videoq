import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluationCases } from '../scripts/course-skill-evaluation/cases';
import { runComparisonCohort, type CohortManifest, type CohortOutcome } from '../scripts/course-skill-evaluation/cohort';

const manifest: CohortManifest = { version: 1, seed: 'fixed-private-cohort-seed', repetitions: 2, definitionHash: 'a'.repeat(64), bootstrapHash: '9'.repeat(64), sourceHashes: ['b'.repeat(64)], approvedSkillHashes: ['c'.repeat(64)], executorVersion: 'unit-fixture-not-a-real-evaluation', model: 'fixture', reasoning: 'medium', contextWindow: 32768, timeoutMs: 1000, baseCommits: Object.fromEntries(evaluationCases.map(c => [c.id, '1'.repeat(40)])) };
const outcome: CohortOutcome = { validity: 'valid', functional: true, elapsedMs: 1, inputTokens: 10, outputTokens: 2, detailPath: 'private-fixture.json', detailSha256: 'd'.repeat(64), baseCommit: '1'.repeat(40) };
async function fixture(test: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'videoq-cohort-unit-'));
  try { await test(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const options = (directory: string, run = vi.fn().mockResolvedValue(outcome)) => ({ directory, manifest, cases: evaluationCases, maxTrials: 1, verifyInputs: () => Promise.resolve(), run: async (slot: { blindId: string }) => {
  const value = await run(slot) as CohortOutcome, detailPath = join(directory, `${slot.blindId}.json`), body = JSON.stringify(value);
  await writeFile(detailPath, body, { mode: 0o600 });
  return { ...value, detailPath, detailSha256: createHash('sha256').update(body).digest('hex') };
} });

it('resumes an exact completed prefix without rerunning earlier slots', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue(outcome);
  const first = await runComparisonCohort(options(directory, run));
  const next = await runComparisonCohort({ ...options(directory, run), maxTrials: 2 });
  expect(next.results).toHaveLength(3);
  expect(next.results[0]).toEqual(first.results[0]);
  expect(new Set(run.mock.calls.map(c => c[0].blindId)).size).toBe(3);
  expect(next.completed).toBe(false); expect(next.humanAssessmentCompleted).toBe(false);
}));
it('refuses changed sources, definitions or approved versions before invoking an executor', () => fixture(async directory => {
  await runComparisonCohort(options(directory));
  for (const changes of [{ sourceHashes: ['d'.repeat(64)] }, { definitionHash: 'e'.repeat(64) }, { approvedSkillHashes: ['f'.repeat(64)] }]) {
    const run = vi.fn();
    await expect(runComparisonCohort({ ...options(directory, run), manifest: { ...manifest, ...changes } })).rejects.toThrow('COHORT_INPUTS_CHANGED');
    expect(run).not.toHaveBeenCalled();
  }
}));
it('keeps a failed active invocation unresolved instead of silently restarting it', () => fixture(async directory => {
  const run = vi.fn().mockRejectedValue(new Error('executor disconnected'));
  await expect(runComparisonCohort(options(directory, run))).rejects.toThrow('executor disconnected');
  const state = JSON.parse(await readFile(join(directory, 'cohort.json'), 'utf8'));
  expect(state.active).not.toBeNull(); expect(state.results).toHaveLength(0);
  await expect(runComparisonCohort(options(directory, run))).rejects.toThrow('COHORT_ACTIVE_TRIAL_REQUIRES_PROCESS_INSPECTION');
  expect(run).toHaveBeenCalledTimes(1);
}));
it('does not resume through an invalid trial or claim a completed comparison', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue({ ...outcome, validity: 'infrastructure-failure', functional: null });
  const state = await runComparisonCohort({ ...options(directory, run), maxTrials: 60 });
  expect(state.results).toHaveLength(1); expect(state.completed).toBe(false);
  await expect(runComparisonCohort(options(directory, run))).rejects.toThrow('COHORT_HAS_INVALID_TRIAL');
  expect(run).toHaveBeenCalledTimes(1);
}));
it('checks live inputs again before every paid trial', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue(outcome), verifyInputs = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('source head changed'));
  await expect(runComparisonCohort({ ...options(directory, run), maxTrials: 2, verifyInputs })).rejects.toThrow('source head changed');
  expect(run).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(join(directory, 'cohort.json'), 'utf8')).results).toHaveLength(1);
}));
it('never treats a pre-existing lock as proof that an earlier model has stopped', () => fixture(async directory => {
  await writeFile(join(directory, 'cohort.lock'), '{"pid":999999}');
  const run = vi.fn();
  await expect(runComparisonCohort(options(directory, run))).rejects.toThrow('COHORT_ALREADY_RUNNING_OR_UNRESOLVED');
  expect(run).not.toHaveBeenCalled();
}));
it('requires approved inputs and preserves model failures as valid negative results', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue({ ...outcome, functional: false });
  await expect(runComparisonCohort({ ...options(directory, run), manifest: { ...manifest, approvedSkillHashes: [] } })).rejects.toThrow('COHORT_APPROVED_SKILLS_REQUIRED');
  expect(run).not.toHaveBeenCalled();
  const state = await runComparisonCohort({ ...options(directory, run), maxTrials: 60 });
  expect(state.completed).toBe(true); expect(state.results).toHaveLength(60);
  expect(state.results.every(r => r.outcome.functional === false)).toBe(true);
  expect(state.humanAssessmentCompleted).toBe(false);
}));
it('rejects a changed detailed result on resume before running another trial', () => fixture(async directory => {
  const state = await runComparisonCohort(options(directory));
  await writeFile(state.results[0].outcome.detailPath, '{"tampered":true}');
  const run = vi.fn();
  await expect(runComparisonCohort(options(directory, run))).rejects.toThrow('COHORT_DETAIL_CHANGED');
  expect(run).not.toHaveBeenCalled();
}));
it('rejects a successful-looking trial outside the fixed time budget', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue({ ...outcome, elapsedMs: 1001 });
  await expect(runComparisonCohort(options(directory, run))).rejects.toThrow('COHORT_TIME_BUDGET_EXCEEDED');
  expect(JSON.parse(await readFile(join(directory, 'cohort.json'), 'utf8')).completed).toBe(false);
}));
it('rejects an executor that started from a different commit', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue({ ...outcome, baseCommit: '2'.repeat(40) });
  await expect(runComparisonCohort(options(directory, run))).rejects.toThrow('COHORT_BASE_COMMIT_CHANGED');
}));
it('invalidates a finished trial if its inputs cannot be verified after execution', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue(outcome), verifyInputs = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('publication withdrawn'));
  const state = await runComparisonCohort({ ...options(directory, run), maxTrials: 60, verifyInputs });
  expect(run).toHaveBeenCalledTimes(1);
  expect(state.results[0]).toMatchObject({ inputsVerifiedAfterRun: false, outcome: { validity: 'infrastructure-failure' } });
  expect(state.completed).toBe(false);
}));
it('retains timeouts as negative performance results and continues the fixed plan', () => fixture(async directory => {
  const run = vi.fn().mockResolvedValue({ ...outcome, validity: 'budget-exceeded', elapsedMs: 1200, functional: false });
  const first = await runComparisonCohort({ ...options(directory, run), maxTrials: 2 });
  expect(first.results).toHaveLength(2); expect(first.completed).toBe(false);
  const next = await runComparisonCohort(options(directory, run));
  expect(next.results).toHaveLength(3); expect(run).toHaveBeenCalledTimes(3);
}));
