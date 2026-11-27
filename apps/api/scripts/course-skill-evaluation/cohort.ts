import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { comparisonPlan, type ComparisonCondition } from './plan';
import type { EvaluationCase } from './cases';

export type CohortManifest = {
  version: 1; seed: string; repetitions: number;
  definitionHash: string; bootstrapHash: string; sourceHashes: string[]; approvedSkillHashes: string[];
  executorVersion: string; model: string; reasoning: 'medium'; contextWindow: number; timeoutMs: number;
  baseCommits: Record<string, string>;
};
export type CohortSlot = { taskId: string; repetition: number; condition: ComparisonCondition; blindId: string };
export type CohortOutcome = {
  validity: 'valid' | 'infrastructure-failure' | 'budget-exceeded';
  functional: boolean | null; elapsedMs: number; inputTokens: number | null; outputTokens: number | null;
  detailPath: string; detailSha256: string; baseCommit: string;
};
export type CohortState = {
  version: 1; manifestHash: string; manifest: CohortManifest; plan: CohortSlot[];
  results: { slot: CohortSlot; outcome: CohortOutcome; inputsVerifiedAfterRun: boolean }[];
  active: { slot: CohortSlot; parentPid: number; startedAt: string } | null;
  completed: boolean; humanAssessmentCompleted: false;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = (value: string) => /^[a-f0-9]{64}$/.test(value);

function validateManifest(value: CohortManifest) {
  if (value.version !== 1 || !hex(value.definitionHash) || !hex(value.bootstrapHash) || !value.sourceHashes.length || value.sourceHashes.some(h => !hex(h))) throw new Error('INVALID_COHORT_MANIFEST');
  if (!value.approvedSkillHashes.length || value.approvedSkillHashes.some(h => !hex(h))) throw new Error('COHORT_APPROVED_SKILLS_REQUIRED');
  if (!value.executorVersion || !value.model || value.reasoning !== 'medium' || value.contextWindow !== 32768 || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 300_000) throw new Error('INVALID_COHORT_CONFIGURATION');
}
async function validateOutcome(value: CohortOutcome, timeoutMs: number, baseCommit: string) {
  if (!['valid', 'infrastructure-failure', 'budget-exceeded'].includes(value.validity) || ![true, false, null].includes(value.functional) || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || !value.detailPath) throw new Error('INVALID_COHORT_OUTCOME');
  for (const tokens of [value.inputTokens, value.outputTokens]) if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new Error('INVALID_COHORT_USAGE');
  if (value.validity === 'valid' && value.elapsedMs > timeoutMs) throw new Error('COHORT_TIME_BUDGET_EXCEEDED');
  if (value.baseCommit !== baseCommit) throw new Error('COHORT_BASE_COMMIT_CHANGED');
  if (!hex(value.detailSha256) || (await stat(value.detailPath)).size > 32_000_000 || createHash('sha256').update(await readFile(value.detailPath)).digest('hex') !== value.detailSha256) throw new Error('COHORT_DETAIL_CHANGED');
}

/** Artifact verification only; never claims that a human has assessed quality. */
export async function validateCompletedCohort(state: CohortState, cases: readonly EvaluationCase[]) {
  validateManifest(state.manifest);
  if (state.manifest.definitionHash !== digest(cases) || !state.manifest.baseCommits || Object.keys(state.manifest.baseCommits).length !== cases.length || cases.some(c => !/^[a-f0-9]{40}$/.test(state.manifest.baseCommits[c.id] ?? ''))) throw new Error('COHORT_REVIEW_DEFINITION_CHANGED');
  const plan = comparisonPlan(cases, state.manifest.seed, state.manifest.repetitions);
  if (state.version !== 1 || state.completed !== true || state.active !== null || state.humanAssessmentCompleted !== false || state.manifestHash !== digest(state.manifest)
    || digest(state.plan) !== digest(plan) || state.results.length !== plan.length) throw new Error('COHORT_REVIEW_REQUIRES_COMPLETE_EXECUTION');
  for (const [index, result] of state.results.entries()) {
    if (digest(result.slot) !== digest(plan[index]) || result.inputsVerifiedAfterRun !== true || result.outcome.validity === 'infrastructure-failure') throw new Error('COHORT_REVIEW_INVALID_TRIAL');
    await validateOutcome(result.outcome, state.manifest.timeoutMs, state.manifest.baseCommits[result.slot.taskId]);
  }
}

/** Resume completed prefixes only. A crashed active slot is never silently rerun. */
export async function runComparisonCohort(options: {
  directory: string; manifest: CohortManifest; cases: readonly EvaluationCase[]; maxTrials: number;
  verifyInputs: () => Promise<void>;
  shouldStop?: () => Promise<boolean>;
  run: (slot: CohortSlot) => Promise<CohortOutcome>;
}) {
  validateManifest(options.manifest);
  if (!Number.isSafeInteger(options.maxTrials) || options.maxTrials < 1 || options.maxTrials > 150) throw new Error('INVALID_COHORT_BATCH_SIZE');
  const plan = comparisonPlan(options.cases, options.manifest.seed, options.manifest.repetitions);
  if (!options.manifest.baseCommits || Object.keys(options.manifest.baseCommits).length !== options.cases.length || options.cases.some(c => !/^[a-f0-9]{40}$/.test(options.manifest.baseCommits[c.id] ?? ''))) throw new Error('COHORT_BASE_COMMITS_REQUIRED');
  const manifestHash = digest(options.manifest);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, 'cohort.json'), lock = join(options.directory, 'cohort.lock');
  // Do not guess whether a leftover lock's process or detached model is terminal.
  const handle = await open(lock, 'wx', 0o600).catch(() => { throw new Error('COHORT_ALREADY_RUNNING_OR_UNRESOLVED'); });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const stored = await readFile(path, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    const state: CohortState = stored ? JSON.parse(stored) as CohortState : { version: 1, manifestHash, manifest: options.manifest, plan, results: [], active: null, completed: false, humanAssessmentCompleted: false };
    if (state.version !== 1 || state.humanAssessmentCompleted !== false || state.manifestHash !== manifestHash || digest(state.manifest) !== manifestHash || digest(state.plan) !== digest(plan) || !Array.isArray(state.results) || state.results.length > plan.length) throw new Error('COHORT_INPUTS_CHANGED');
    for (const [index, result] of state.results.entries()) {
      if (digest(result.slot) !== digest(plan[index])) throw new Error('COHORT_RESULT_ORDER_CHANGED');
      if (typeof result.inputsVerifiedAfterRun !== 'boolean' || (!result.inputsVerifiedAfterRun && result.outcome.validity !== 'infrastructure-failure')) throw new Error('COHORT_INPUT_VERIFICATION_CHANGED');
      await validateOutcome(result.outcome, options.manifest.timeoutMs, options.manifest.baseCommits[result.slot.taskId]);
    }
    if (state.active) throw new Error('COHORT_ACTIVE_TRIAL_REQUIRES_PROCESS_INSPECTION');
    if (state.results.some(r => r.outcome.validity === 'infrastructure-failure')) throw new Error('COHORT_HAS_INVALID_TRIAL');
    if (state.completed !== (state.results.length === plan.length)) throw new Error('COHORT_COMPLETION_MISMATCH');
    const save = async () => {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    };
    for (let count = 0; count < options.maxTrials && state.results.length < plan.length; count++) {
      if (await options.shouldStop?.()) break;
      await options.verifyInputs();
      const slot = plan[state.results.length];
      state.active = { slot, parentPid: process.pid, startedAt: new Date().toISOString() };
      await save();
      // If execution throws, keep the active record for authoritative process
      // inspection instead of manufacturing a result or restarting the model.
      let outcome = await options.run(slot);
      await validateOutcome(outcome, options.manifest.timeoutMs, options.manifest.baseCommits[slot.taskId]);
      let inputsVerifiedAfterRun = true;
      try { await options.verifyInputs(); }
      catch { inputsVerifiedAfterRun = false; outcome = { ...outcome, validity: 'infrastructure-failure' }; }
      state.results.push({ slot, outcome, inputsVerifiedAfterRun }); state.active = null;
      state.completed = state.results.length === plan.length && state.results.every(r => r.outcome.validity !== 'infrastructure-failure');
      await save();
      if (outcome.validity === 'infrastructure-failure') break;
    }
    return state;
  } finally { await handle.close(); await unlink(lock); }
}
