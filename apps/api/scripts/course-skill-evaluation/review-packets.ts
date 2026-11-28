import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validateCompletedCohort, type CohortState } from './cohort';
import type { EvaluationCase } from './cases';
import { executionReviewEvidence } from './execution-review-evidence';

const detailSchema = z.object({
  execution: z.object({ answer: z.string().max(2_000_000) }),
  reviewFiles: z.object({ files: z.array(z.object({ path: z.string(), content: z.string().max(200_000) }).strict()).max(256), omitted: z.array(z.string()).max(256) }).strict(),
});

/** Hide assigned labels and machine scores; prose/citations may reveal tool use. */
export async function exportReviewPackets(options: { directory: string; output: string; cases: readonly EvaluationCase[]; includeExecutionEvidence?: boolean }) {
  const state = JSON.parse(await readFile(join(options.directory, 'cohort.json'), 'utf8')) as CohortState;
  await validateCompletedCohort(state, options.cases);
  const packets = [];
  for (const result of state.results) {
    const task = options.cases.find(c => c.id === result.slot.taskId);
    if (!task) throw new Error('COHORT_REVIEW_TASK_MISSING');
    const raw = await readFile(result.outcome.detailPath, 'utf8');
    if (createHash('sha256').update(raw).digest('hex') !== result.outcome.detailSha256) throw new Error('COHORT_DETAIL_CHANGED');
    const detail = detailSchema.parse(JSON.parse(raw));
    for (const file of detail.reviewFiles.files) {
      const parts = file.path.split('/');
      if (file.path.startsWith('/') || parts.some(p => ['', '.', '..', '.git', '.agents', 'node_modules'].includes(p))) throw new Error('COHORT_REVIEW_FILE_PATH_INVALID');
    }
    const evidence = options.includeExecutionEvidence ? executionReviewEvidence((JSON.parse(raw) as { execution: unknown }).execution, result.slot.condition, join(options.directory, 'workspaces', result.slot.blindId)) : undefined;
    packets.push({ blindId: result.slot.blindId, taskId: task.id, prompt: task.prompt, criteria: task.humanCriteria, answer: detail.execution.answer, ...detail.reviewFiles, ...(evidence ? { executionEvidence: evidence } : {}) });
  }
  // Do not expose execution ordering, repeated-trial labels or machine grades.
  packets.sort((a, b) => a.blindId.localeCompare(b.blindId));
  await mkdir(options.output, { mode: 0o700 }); // Existing exports are immutable.
  const reviewer = join(options.output, 'reviewer'); await mkdir(reviewer, { mode: 0o700 });
  const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const bundle = { version: options.includeExecutionEvidence ? 2 : 1, humanAssessmentCompleted: false, maskingLimit: 'Assigned conditions and machine scores are hidden. Answers, citations and optional execution evidence may suggest tool use; complete blinding is not guaranteed.', packets };
  const packetHash = createHash('sha256').update(JSON.stringify(bundle, null, 2) + '\n').digest('hex');
  await write(join(reviewer, 'packets.json'), bundle);
  await write(join(reviewer, 'assessment-template.json'), { version: 1, packetHash, reviewer: '', assessments: packets.map(packet => ({ blindId: packet.blindId, criteria: packet.criteria.map(criterion => ({ criterion, met: null })), misapplied: null, unsupportedClaim: null, notes: '' })) });
  await write(join(options.output, 'operator-key.json'), { manifestHash: state.manifestHash, packetHash, humanAssessmentCompleted: false, trials: state.results.map(r => ({ blindId: r.slot.blindId, taskId: r.slot.taskId, condition: r.slot.condition, repetition: r.slot.repetition, ...r.outcome })) });
  await write(join(options.output, 'READY.json'), { packets: packets.length, humanAssessmentCompleted: false });
  return { packets: packets.length, humanAssessmentCompleted: false };
}
