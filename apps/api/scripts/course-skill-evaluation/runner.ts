import { createHash } from 'node:crypto';
import { copyFile, mkdir, realpath, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCodexTrial, codexVersion } from './codex';
import { initializeCaseRepository, gradeCase } from './fixtures';
import { startEvaluationMcp } from './mcp-server';
import { assertPublicationVersions } from './publications';
import type { CohortManifest, CohortOutcome, CohortSlot } from './cohort';
import type { EvaluationCase } from './cases';
import type { readOnlySearchTransport } from './environment';
import type { Bindings } from '../../src/types/bindings';

export async function executeComparisonSlot(options: {
  slot: CohortSlot; task: EvaluationCase; manifest: CohortManifest; directory: string;
  env: Bindings; ownerId: string; courseId: number; videoIds: number[]; bootstrapSource: string;
  createTransport: () => ReturnType<typeof readOnlySearchTransport>;
  client?: typeof runCodexTrial;
  readExecutorVersion?: typeof codexVersion;
}): Promise<CohortOutcome> {
  if (options.slot.taskId !== options.task.id) throw new Error('COHORT_TASK_MISMATCH');
  if (!options.videoIds.length || options.videoIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('COHORT_VIDEO_SCOPE_INVALID');
  await assertPublicationVersions(options.env, options.ownerId, options.courseId, options.manifest.approvedSkillHashes);
  if (await (options.readExecutorVersion ?? codexVersion)() !== options.manifest.executorVersion) throw new Error('COHORT_EXECUTOR_VERSION_CHANGED');
  if (createHash('sha256').update(await readFile(options.bootstrapSource)).digest('hex') !== options.manifest.bootstrapHash) throw new Error('COHORT_BOOTSTRAP_CHANGED');
  const parent = join(options.directory, 'workspaces'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const folder = join(parent, options.slot.blindId);
  await mkdir(folder, { mode: 0o700 }); // Existing files are not a fresh trial.
  const workspace = await realpath(folder);
  const baseCommit = await initializeCaseRepository(workspace, options.task);
  if (baseCommit !== options.manifest.baseCommits[options.task.id]) throw new Error('COHORT_BASE_COMMIT_CHANGED');
  let bootstrapPath: string | undefined;
  if (options.slot.condition === 'C') {
    const skill = join(workspace, '.agents/skills/videoq-course-skills'); await mkdir(skill, { recursive: true, mode: 0o700 });
    bootstrapPath = join(skill, 'SKILL.md'); await copyFile(options.bootstrapSource, bootstrapPath);
  }
  const transport = options.slot.condition === 'A' ? undefined : options.createTransport();
  const env = transport ? { ...options.env, AI: transport.ai, SCENE_VECTORIZE_768: transport.index } as unknown as Bindings : options.env;
  let server: Awaited<ReturnType<typeof startEvaluationMcp>> | undefined;
  try {
    if (transport) server = await startEvaluationMcp({ env, ownerId: options.ownerId, courseId: options.courseId, mode: options.slot.condition === 'C' ? 'skills' : 'search', maxToolCalls: 24 });
    const scope = `VideoQ講座${options.courseId}の教材を利用できる場合、利用範囲は凍結した動画${options.videoIds.join('・')}だけです。講座全体を確認したと主張しないでください。資料がなければ一般的な実装判断として進めてください。`;
    const common = `${scope}\n現在の作業用リポジトリだけを変更し、外部Webや他のリポジトリ・個人設定にはアクセスしません。新しい依存パッケージは追加しません。資料に基づく判断と一般的な判断を分け、最後に変更・検証・利用した出典（あれば動画IDと時刻）を簡潔に報告してください。`;
    const instructions = options.task.kind === 'code' ? 'node:testで回帰テストを書き、実行してください。' : 'ファイルの実装や変更は不要です。確認できない情報は明確にしてください。';
    const execution = await (options.client ?? runCodexTrial)({ workspace, prompt: `${common}\n${instructions}\n\n${options.task.prompt}`, model: options.manifest.model, timeoutMs: options.manifest.timeoutMs, bootstrapPath, server });
    const grade = await gradeCase(options.task, workspace);
    const units = execution.usage as ({ input_tokens?: number; output_tokens?: number } | undefined)[];
    const measured = units.length > 0 && units.every(u => Number.isSafeInteger(u?.input_tokens) && Number.isSafeInteger(u?.output_tokens));
    const inputTokens = measured ? units.reduce((n, u) => n + u!.input_tokens!, 0) : null;
    const outputTokens = measured ? units.reduce((n, u) => n + u!.output_tokens!, 0) : null;
    const overBudget = execution.timedOut || execution.elapsedMs > options.manifest.timeoutMs;
    const validity = overBudget ? 'budget-exceeded' : !execution.completed || (transport?.stats.failedRequests ?? 0) > 0 ? 'infrastructure-failure' : 'valid';
    const detail = { slot: options.slot, baseCommit, execution, grade, calls: server?.calls ?? [], search: transport?.stats ?? null,
      humanCriteria: options.task.humanCriteria, humanAssessmentCompleted: false, monetaryCostUsd: null };
    const reports = join(options.directory, 'details'); await mkdir(reports, { recursive: true, mode: 0o700 });
    const detailPath = join(reports, `${options.slot.blindId}.json`), content = JSON.stringify(detail, null, 2) + '\n';
    await writeFile(detailPath, content, { mode: 0o600, flag: 'wx' });
    return { validity, baseCommit, functional: overBudget && options.task.kind === 'code' ? false : execution.completed ? grade.functional : null, elapsedMs: execution.elapsedMs,
      inputTokens, outputTokens, detailPath, detailSha256: createHash('sha256').update(content).digest('hex') };
  } finally { await server?.close(); }
}
