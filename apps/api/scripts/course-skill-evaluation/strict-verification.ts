import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { z } from 'zod';
import { validateCompletedCohort, type CohortState } from './cohort';
import { gradeCaseStrict } from './strict-grading';
import { writeCaseFixture } from './fixtures';
import type { EvaluationCase } from './cases';

export const verificationHash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const rowSchema = z.object({ blindId: z.string(), detailSha256: z.string(), originalFunctional: z.boolean().nullable(), verifiedFunctional: z.boolean().nullable(), timedOut: z.boolean() }).strict();
const verificationSchema = z.object({ version: z.literal(1), method: z.literal('node-test-process-events-v1'), complete: z.literal(true), cohortManifestHash: z.string(), snapshotSha256: z.string(), nodeVersion: z.string(), graderSourceSha256: z.string(), results: z.array(rowSchema) }).strict();
const filesSchema = z.array(z.object({ path: z.string(), content: z.string() }).strict()).max(256);

export async function verifyFrozenCohort(options: { directory: string; output: string; cases: readonly EvaluationCase[] }) {
  const raw = await readFile(join(options.directory, 'cohort.json'), 'utf8'), state = JSON.parse(raw) as CohortState;
  await validateCompletedCohort(state, options.cases);
  const directory = await mkdtemp(join(tmpdir(), 'videoq-complete-recheck-'));
  try {
    const results: z.infer<typeof rowSchema>[] = [];
    for (const result of state.results) {
      const detailRaw = await readFile(result.outcome.detailPath, 'utf8');
      if (verificationHash(detailRaw) !== result.outcome.detailSha256) throw new Error('COHORT_DETAIL_CHANGED');
      const detail = JSON.parse(detailRaw) as { reviewFiles: { files: unknown; omitted: string[] } };
      const files = filesSchema.parse(detail.reviewFiles.files);
      if (new Set(files.map(f => f.path)).size !== files.length) throw new Error('VERIFICATION_DUPLICATE_FILE');
      const task = options.cases.find(c => c.id === result.slot.taskId)!, workspace = join(directory, result.slot.blindId);
      await writeCaseFixture(workspace, Object.fromEntries(files.map(f => [f.path, f.content])));
      const grade = await gradeCaseStrict(task, workspace);
      results.push({ blindId: result.slot.blindId, detailSha256: result.outcome.detailSha256, originalFunctional: result.outcome.functional, verifiedFunctional: grade.functional, timedOut: grade.timedOut });
    }
    const report = { version: 1, method: 'node-test-process-events-v1', complete: true, cohortManifestHash: state.manifestHash, snapshotSha256: verificationHash(raw), nodeVersion: process.version,
      graderSourceSha256: verificationHash(await readFile(new URL('./strict-grading.ts', import.meta.url), 'utf8')), results };
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return { trials: results.length, codePasses: results.filter(r => r.verifiedFunctional === true).length, discrepancies: results.filter(r => r.originalFunctional !== r.verifiedFunctional).length, modelReruns: 0, originalRecordsModified: false };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function readStrictVerification(state: CohortState, snapshotSha256: string, path: string) {
  const raw = await readFile(path, 'utf8'), report = verificationSchema.parse(JSON.parse(raw));
  if (report.cohortManifestHash !== state.manifestHash || report.snapshotSha256 !== snapshotSha256 || report.results.length !== state.results.length || new Set(report.results.map(r => r.blindId)).size !== state.results.length
    || report.graderSourceSha256 !== verificationHash(await readFile(new URL('./strict-grading.ts', import.meta.url), 'utf8'))) throw new Error('VERIFICATION_INPUTS_CHANGED');
  for (const result of state.results) {
    const row = report.results.find(r => r.blindId === result.slot.blindId);
    if (!row || row.detailSha256 !== result.outcome.detailSha256 || row.originalFunctional !== result.outcome.functional || (row.originalFunctional === null) !== (row.verifiedFunctional === null)
      || row.timedOut && row.verifiedFunctional === true) throw new Error('VERIFICATION_RESULT_CHANGED');
  }
  return { report, digest: verificationHash(raw) };
}
