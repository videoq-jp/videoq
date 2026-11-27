import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluationCases } from '../scripts/course-skill-evaluation/cases';
import { runComparisonCohort, type CohortManifest } from '../scripts/course-skill-evaluation/cohort';
import { exportReviewPackets } from '../scripts/course-skill-evaluation/review-packets';
import { createAssessmentReport } from '../scripts/course-skill-evaluation/assessment-report';
import { verifyFrozenCohort } from '../scripts/course-skill-evaluation/strict-verification';

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'videoq-assessment-report-unit-'));
  try { await run(await setup(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function setup(directory: string) {
  const manifest: CohortManifest = { version: 1, seed: 'synthetic-report-fixture', repetitions: 2, definitionHash: hash(JSON.stringify(evaluationCases)), bootstrapHash: 'a'.repeat(64), sourceHashes: ['b'.repeat(64)], approvedSkillHashes: ['c'.repeat(64)], executorVersion: 'synthetic', model: 'synthetic', reasoning: 'medium', contextWindow: 32768, timeoutMs: 1000, baseCommits: Object.fromEntries(evaluationCases.map(c => [c.id, '1'.repeat(40)])) };
  const state = await runComparisonCohort({ directory, manifest, cases: evaluationCases, maxTrials: 60, verifyInputs: async () => undefined, run: async slot => {
    const detailPath = join(directory, `${slot.blindId}.json`), body = JSON.stringify({ execution: { answer: 'Synthetic unit answer' }, reviewFiles: { files: [], omitted: [] },
      calls: slot.condition === 'A' ? [] : [{ name: slot.condition === 'B' ? 'search_scenes' : 'read_course_skill_resource', success: true }] });
    await writeFile(detailPath, body);
    return { validity: 'valid', functional: evaluationCases.find(c => c.id === slot.taskId)!.kind === 'code' ? slot.condition !== 'A' : null, elapsedMs: slot.condition === 'A' ? 10 : 20, inputTokens: slot.condition === 'A' ? null : 3, outputTokens: 2, baseCommit: '1'.repeat(40), detailPath, detailSha256: hash(body) };
  } });
  const outputDirectory = join(directory, 'review'); await exportReviewPackets({ directory, output: outputDirectory, cases: evaluationCases });
  const reviewerDirectory = join(outputDirectory, 'reviewer'), assessmentFile = join(directory, 'assessments.json'), output = join(directory, 'report.json');
  const template = JSON.parse(await readFile(join(reviewerDirectory, 'assessment-template.json'), 'utf8'));
  const completed = { ...template, reviewer: 'Synthetic unit fixture, not a real human assessment', decision: 'human-reviewed', assessments: template.assessments.map((a: { blindId: string; criteria: { criterion: string }[] }, index: number) => ({ blindId: a.blindId, criteria: a.criteria.map(c => ({ ...c, met: true })), misapplied: index === 0, unsupportedClaim: false, notes: 'Synthetic unit fixture evidence only.' })) };
  await writeFile(assessmentFile, JSON.stringify(completed));
  // Synthetic verifier fixture for report-unit tests; the separate integration
  // test below executes the real verifier over every frozen output.
  const verificationFile = join(directory, 'verification.json');
  await writeFile(verificationFile, JSON.stringify({ version: 1, method: 'node-test-process-events-v1', complete: true, cohortManifestHash: state.manifestHash,
    snapshotSha256: hash(await readFile(join(directory, 'cohort.json'), 'utf8')), nodeVersion: 'synthetic-unit-fixture',
    graderSourceSha256: hash(await readFile('scripts/course-skill-evaluation/strict-grading.ts', 'utf8')),
    results: state.results.map(r => ({ blindId: r.slot.blindId, detailSha256: r.outcome.detailSha256, originalFunctional: r.outcome.functional, verifiedFunctional: r.outcome.functional, timedOut: false })) }));
  return { directory, reviewerDirectory, assessmentFile, verificationFile, output, cases: evaluationCases, completed, template };
}
test('keeps machine and human denominators separate and preserves missing usage', () => fixture(async f => {
  const report = await createAssessmentReport(f);
  expect(report.humanAssessmentRecorded).toBe(true);
  expect(report.conditions.map(c => c.trials)).toEqual([20, 20, 20]);
  expect(report.conditions.map(c => c.functional)).toEqual([{ passed: 0, total: 16 }, { passed: 16, total: 16 }, { passed: 16, total: 16 }]);
  expect(report.conditions[0].inputTokens).toBeNull();
  expect(report.conditions[1].inputTokens?.count).toBe(20);
  expect(report.conditions.reduce((n, c) => n + c.judgment.misapplied, 0)).toBe(1);
  expect(report.conditions.every(c => c.monetaryCostUsd === null)).toBe(true);
  expect(report.conditions[0].toolUse.trialsWithSuccessfulResourceRead).toBe(0);
  expect(report.conditions[1].toolUse.trialsWithSuccessfulSearch).toBe(20);
  expect(report.conditions[2].toolUse.trialsWithSuccessfulResourceRead).toBe(20);
  await expect(createAssessmentReport(f)).rejects.toThrow();
}));
test('cannot count an empty review template as a human judgment', () => fixture(async f => {
  await writeFile(f.assessmentFile, JSON.stringify(f.template));
  await expect(createAssessmentReport(f)).rejects.toThrow();
}));
test('rejects duplicate scores, changed criteria and changed packet bytes', () => fixture(async f => {
  const duplicate = structuredClone(f.completed); duplicate.assessments[0] = duplicate.assessments[1];
  await writeFile(f.assessmentFile, JSON.stringify(duplicate));
  await expect(createAssessmentReport(f)).rejects.toThrow('TRIAL_SET_CHANGED');
  const altered = structuredClone(f.completed); altered.assessments[0].criteria[0].criterion = 'Different grading criterion';
  await writeFile(f.assessmentFile, JSON.stringify(altered));
  await expect(createAssessmentReport(f)).rejects.toThrow('CONTENT_CHANGED');
  await writeFile(f.assessmentFile, JSON.stringify(f.completed));
  await writeFile(join(f.reviewerDirectory, 'packets.json'), '{}');
  await expect(createAssessmentReport(f)).rejects.toThrow('PACKET_CHANGED');
}));
test('refuses substituted answers even when a packet hash is recomputed', () => fixture(async f => {
  const path = join(f.reviewerDirectory, 'packets.json'), packet = JSON.parse(await readFile(path, 'utf8'));
  packet.packets[0].answer = 'Changed after the experiment';
  const raw = JSON.stringify(packet); await writeFile(path, raw);
  await writeFile(f.assessmentFile, JSON.stringify({ ...f.completed, packetHash: hash(raw) }));
  await expect(createAssessmentReport(f)).rejects.toThrow('CONTENT_CHANGED');
}));
test('requires a matching complete frozen-code verification artifact', () => fixture(async f => {
  const verification = JSON.parse(await readFile(f.verificationFile, 'utf8'));
  verification.snapshotSha256 = '0'.repeat(64);
  await writeFile(f.verificationFile, JSON.stringify(verification));
  await expect(createAssessmentReport(f)).rejects.toThrow('VERIFICATION_INPUTS_CHANGED');
}));
test('verifies all frozen outputs and does not promote old failures or hide new failures', () => fixture(async f => {
  const output = join(f.directory, 'real-verification.json');
  // This fixture intentionally contains no src/main.mjs in frozen snapshots:
  // independent verification must reject every code result, even though the
  // synthetic legacy fixture marks B/C as successful.
  const summary = await verifyFrozenCohort({ directory: f.directory, output, cases: evaluationCases });
  expect(summary).toMatchObject({ trials: 60, codePasses: 0, discrepancies: 32, modelReruns: 0, originalRecordsModified: false });
  const report = await createAssessmentReport({ ...f, verificationFile: output });
  expect(report.conditions.map(c => c.functional.passed)).toEqual([0, 0, 0]);
  expect(report.conditions.map(c => c.originalFunctionalPasses)).toEqual([0, 16, 16]);
  expect(report.conditions.map(c => c.verificationDiscrepancies)).toEqual([0, 16, 16]);
}), 20000);

test('labels AI judgments explicitly and requires model provenance', () => fixture(async f => {
  const ai = { ...f.completed, decision: 'ai-reviewed' };
  await writeFile(f.assessmentFile, JSON.stringify(ai));
  await expect(createAssessmentReport(f)).rejects.toThrow();
  await writeFile(f.assessmentFile, JSON.stringify({ ...ai, ai: { provider: 'synthetic', model: 'independent-assessor-fixture', protocolHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64), evidenceHash: 'c'.repeat(64) } }));
  const result = await createAssessmentReport(f);
  expect(result.humanAssessmentRecorded).toBe(false);
  expect(result.aiAssessmentRecorded).toBe(true);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  expect(report.assessmentMethod).toBe('ai-reviewed');
  expect(report.ai.model).toBe('independent-assessor-fixture');
}));
