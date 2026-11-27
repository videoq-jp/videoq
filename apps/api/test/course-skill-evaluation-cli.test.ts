import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
test('defaults to help and refuses pending owner review before touching inputs or starting a DB', async () => {
  const help = await execute(process.execPath, ['--import', 'tsx', 'scripts/run-course-skill-evaluation.ts']);
  expect(help.stdout).toContain('Use --run');
  const root = await mkdtemp(join(tmpdir(), 'videoq-cohort-cli-unit-'));
  try {
    const approvalFile = join(root, 'approval.json'), configFile = join(root, 'config.json'), directory = join(root, 'must-not-exist');
    await writeFile(approvalFile, JSON.stringify({ version: 1, scope: 'local-evaluation-only', status: 'pending', courseId: 51, ownerDecision: '', packages: [] }), { mode: 0o600 });
    const missing = join(root, 'nonexistent-private-input');
    await writeFile(configFile, JSON.stringify({ courseId: 51, accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111', indexName: 'synthetic-index',
      videosFile: missing, runsFile: missing, scenesFile: missing, sourceFile: missing, approvalFile, wranglerAuthFile: missing,
      directory, bootstrapSource: missing, seed: 'synthetic-pending-cohort', model: 'synthetic-no-model-call', timeoutMs: 1000 }), { mode: 0o600 });
    const result = await execute(process.execPath, ['--import', 'tsx', 'scripts/run-course-skill-evaluation.ts', '--run', '--config', configFile]).then(() => null, error => error as { code: number; stdout: string; stderr: string });
    expect(result?.code).toBe(1);
    expect(result?.stdout).toBe('');
    expect(result?.stderr).toContain('Evaluation stopped');
    expect(await stat(directory).then(() => true, () => false)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
