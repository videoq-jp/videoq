import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { validateCompletedCohort, type CohortState, type CohortOutcome, type CohortSlot } from './cohort';
import type { EvaluationCase } from './cases';

const assessmentSchema = z.object({
  version: z.literal(1), packetHash: z.string().regex(/^[a-f0-9]{64}$/), reviewer: z.string().trim().min(1).max(120),
  decision: z.literal('human-reviewed'),
  assessments: z.array(z.object({ blindId: z.string().regex(/^[a-f0-9]{24}$/), criteria: z.array(z.object({ criterion: z.string(), met: z.boolean() }).strict()),
    misapplied: z.boolean(), unsupportedClaim: z.boolean(), notes: z.string().trim().min(1).max(4000),
  }).strict()).min(1).max(150),
}).strict();
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type AssessmentRow = CohortOutcome & CohortSlot & { kind: EvaluationCase['kind']; criteriaMet: number; criteriaTotal: number; misapplied: boolean; unsupportedClaim: boolean; notes: string };
function distribution(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, min: sorted[0], median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, max: sorted[n - 1], total: sorted.reduce((sum, value) => sum + value, 0) };
}

/** Explicit human record required. Does not change cohort state or infer reviews. */
export async function createAssessmentReport(options: { directory: string; reviewerDirectory: string; assessmentFile: string; output: string; cases: readonly EvaluationCase[] }) {
  const state = JSON.parse(await readFile(join(options.directory, 'cohort.json'), 'utf8')) as CohortState;
  await validateCompletedCohort(state, options.cases);
  const packetRaw = await readFile(join(options.reviewerDirectory, 'packets.json'), 'utf8');
  const assessmentsRaw = await readFile(options.assessmentFile, 'utf8');
  const assessment = assessmentSchema.parse(JSON.parse(assessmentsRaw));
  if (assessment.packetHash !== hash(packetRaw)) throw new Error('ASSESSMENT_PACKET_CHANGED');
  const bundle = JSON.parse(packetRaw) as { version: number; packets: { blindId: string; taskId: string; prompt: string; criteria: string[]; answer: string; files: unknown; omitted: unknown }[] };
  if (bundle.version !== 1 || !Array.isArray(bundle.packets) || bundle.packets.length !== state.results.length || new Set(bundle.packets.map(p => p.blindId)).size !== state.results.length
    || assessment.assessments.length !== state.results.length || new Set(assessment.assessments.map(a => a.blindId)).size !== state.results.length) throw new Error('ASSESSMENT_TRIAL_SET_CHANGED');
  const rows: AssessmentRow[] = [];
  for (const result of state.results) {
    const task = options.cases.find(c => c.id === result.slot.taskId)!;
    const packet = bundle.packets.find(p => p.blindId === result.slot.blindId), score = assessment.assessments.find(a => a.blindId === result.slot.blindId);
    const raw = await readFile(result.outcome.detailPath, 'utf8');
    if (hash(raw) !== result.outcome.detailSha256) throw new Error('COHORT_DETAIL_CHANGED');
    const detail = JSON.parse(raw) as { execution: { answer: string }; reviewFiles: { files: unknown; omitted: unknown } };
    if (!packet || !score || packet.taskId !== task.id || packet.prompt !== task.prompt || !same(packet.criteria, task.humanCriteria) || !same(score.criteria.map(c => c.criterion), task.humanCriteria)
      || packet.answer !== detail.execution.answer || !same(packet.files, detail.reviewFiles.files) || !same(packet.omitted, detail.reviewFiles.omitted)) throw new Error('ASSESSMENT_CONTENT_CHANGED');
    rows.push({ taskId: task.id, kind: task.kind, condition: result.slot.condition, repetition: result.slot.repetition, blindId: result.slot.blindId, ...result.outcome,
      criteriaMet: score.criteria.filter(c => c.met).length, criteriaTotal: score.criteria.length, misapplied: score.misapplied, unsupportedClaim: score.unsupportedClaim, notes: score.notes });
  }
  const conditions = (['A', 'B', 'C'] as const).map(condition => {
    const selected = rows.filter(r => r.condition === condition), code = selected.filter(r => r.kind === 'code');
    if (code.some(r => r.functional === null)) throw new Error('ASSESSMENT_CODE_RESULT_MISSING');
    return { condition, trials: selected.length, functional: { passed: code.filter(r => r.functional).length, total: code.length }, timeouts: selected.filter(r => r.validity === 'budget-exceeded').length,
      human: { misapplied: selected.filter(r => r.misapplied).length, unsupportedClaims: selected.filter(r => r.unsupportedClaim).length, total: selected.length, criteriaMet: selected.reduce((n, r) => n + r.criteriaMet, 0), criteriaTotal: selected.reduce((n, r) => n + r.criteriaTotal, 0) },
      elapsedMs: distribution(selected.map(r => r.elapsedMs)), inputTokens: distribution(selected.flatMap(r => r.inputTokens === null ? [] : [r.inputTokens])), outputTokens: distribution(selected.flatMap(r => r.outputTokens === null ? [] : [r.outputTokens])), monetaryCostUsd: null };
  });
  const report = { version: 1, manifestHash: state.manifestHash, packetHash: assessment.packetHash, assessmentHash: hash(assessmentsRaw), reviewer: assessment.reviewer,
    executionCompleted: true, humanAssessmentRecorded: true, conditions, rows,
    limitations: ['A human-reviewed record was supplied; identity and independence are not cryptographically verified.', 'Condition labels and machine grades were hidden; citations and prose may reveal tool use.', 'Descriptive results for these tasks and frozen videos only; no population-wide causal or statistical-significance claim.', 'Monetary cost is unknown for the existing CLI plan; missing token observations retain their own counts.'] };
  await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { conditions, humanAssessmentRecorded: true };
}
