import { readBoundedRegularFile } from './bounded-file';
import { mkdir, readFile, writeFile, mkdtemp, rm, realpath, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import type { EvaluationCase } from './cases';

/** Freeze reviewable output; excludes retrieval instructions and Git internals. */
export async function captureReviewFiles(workspace: string) {
  const files: { path: string; content: string }[] = [], omitted: string[] = [];
  let bytes = 0, entries = 0;
  const visit = async (relative: string) => {
    for (const entry of (await readdir(join(workspace, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', '.agents', 'node_modules'].includes(entry.name)) continue;
      if (++entries > 256) throw new Error('EVALUATION_REVIEW_FILE_LIMIT');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { omitted.push(path); continue; }
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) { omitted.push(path); continue; }
      const target = join(workspace, path);
      const content = await readBoundedRegularFile(target, 200_000).catch(error => {
        if (error instanceof Error && error.message === 'EVALUATION_ARTIFACT_TOO_LARGE') return null;
        throw error;
      });
      if (!content) { omitted.push(path); continue; }
      if (content.includes(0)) { omitted.push(path); continue; }
      bytes += content.length;
      if (bytes > 2_000_000) throw new Error('EVALUATION_REVIEW_SIZE_LIMIT');
      files.push({ path, content: content.toString('utf8') });
    }
  };
  await visit('');
  return { files, omitted };
}

export async function writeCaseFixture(workspace: string, files: Record<string, string>) {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const [path, text] of Object.entries(files)) {
    const target = resolve(workspace, path);
    if (!target.startsWith(resolve(workspace) + '/')) throw new Error('INVALID_FIXTURE_PATH');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600 });
  }
}

/** Identical task contents yield the same base commit in every condition. */
export async function initializeCaseRepository(workspace: string, task: EvaluationCase) {
  await writeCaseFixture(workspace, task.files);
  const run = promisify(execFile);
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2026-11-27T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-27T00:00:00Z' };
  const git = (args: string[]) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=VideoQ Evaluation', '-c', 'user.email=evaluation@example.test', ...args], { cwd: workspace, env: environment });
  await git(['init', '--quiet', '--template=', '--initial-branch=evaluation']);
  await git(['add', '--', ...Object.keys(task.files)]);
  await git(['commit', '--quiet', '--no-verify', '-m', 'Evaluation task fixture']);
  await mkdir(join(workspace, '.git/info'), { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, '.git/info/exclude'), '.agents/\n', { mode: 0o600 });
  return (await git(['rev-parse', 'HEAD'])).stdout.trim();
}

/** Contract tests run outside the agent's workspace; generated code gets read-only access to its own files. */
export async function gradeCase(task: EvaluationCase, workspace: string) {
  if (task.kind !== 'code' || !task.assertions) return { functional: null, humanReviewRequired: true, stdout: '', stderr: '', timedOut: false };
  for (const path of task.immutableFiles ?? []) {
    const current = await readFile(join(workspace, path), 'utf8').catch(() => null);
    if (current !== task.files[path]) return { functional: false, humanReviewRequired: true, stdout: '', stderr: 'IMMUTABLE_FIXTURE_CHANGED', timedOut: false };
  }
  const grading = await mkdtemp(join(tmpdir(), 'videoq-contract-'));
  const grader = join(grading, 'contract.test.mjs');
  await writeFile(grader, `import assert from 'node:assert/strict';\nimport {test} from 'node:test';\nimport {pathToFileURL} from 'node:url';\nconst subject=await import(pathToFileURL(process.env.VIDEOQ_EVALUATION_WORKSPACE+'/src/main.mjs').href);\n${task.assertions}\n`, { mode: 0o600 });
  try {
    const canonicalWorkspace = await realpath(workspace), canonicalGrading = await realpath(grading);
    // Generated Worker types also extend ProcessEnv; the grader deliberately
    // receives none of the application's bindings or authentication variables.
    const graderEnv = { PATH: process.env.PATH, TZ: 'UTC', VIDEOQ_EVALUATION_WORKSPACE: canonicalWorkspace } as unknown as NodeJS.ProcessEnv;
    return await new Promise<{ functional: boolean; humanReviewRequired: true; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${canonicalWorkspace}`, `--allow-fs-read=${canonicalGrading}`, join(canonicalGrading, 'contract.test.mjs')], {
        cwd: canonicalWorkspace, env: graderEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
      child.stdout.on('data', (data: Buffer) => { stdout = (stdout + data.toString()).slice(-40_000); });
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-40_000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer);
        const tests = /^(?:ℹ|#) tests ([0-9]+)$/m.exec(stdout), passed = /^(?:ℹ|#) pass ([0-9]+)$/m.exec(stdout);
        const executed = tests && passed && Number(tests[1]) > 0 && tests[1] === passed[1] && /^(?:ℹ|#) fail 0$/m.test(stdout);
        resolve({ functional: code === 0 && !timedOut && Boolean(executed), humanReviewRequired: true, stdout, stderr, timedOut });
      });
    });
  } finally { await rm(grading, { recursive: true, force: true }); }
}
export async function validateReferenceCases(cases: readonly EvaluationCase[]) {
  const root = await mkdtemp(join(tmpdir(), 'videoq-fixture-validation-'));
  try {
    const result = [];
    for (const task of cases.filter(c => c.kind === 'code')) {
      if (!task.reference) throw new Error('MISSING_REFERENCE_IMPLEMENTATION');
      const workspace = join(root, task.id);
      await writeCaseFixture(workspace, task.files);
      const baseline = await gradeCase(task, workspace);
      await writeCaseFixture(workspace, task.reference);
      const reference = await gradeCase(task, workspace);
      if (baseline.functional !== false || reference.functional !== true) throw new Error(`INVALID_CASE_CONTRACT:${task.id}:${reference.stderr || reference.stdout}`);
      result.push({ id: task.id, initialFails: true, referencePasses: true });
    }
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}
