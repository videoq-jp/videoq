import { expect, it } from 'vitest';
import { evaluationCases } from '../scripts/course-skill-evaluation/cases';
import { validateReferenceCases, gradeCase, writeCaseFixture, initializeCaseRepository } from '../scripts/course-skill-evaluation/fixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('distinguishes unfinished code from a contract-compliant implementation for all eight coding tasks', async () => {
  expect(new Set(evaluationCases.map(c => c.id)).size).toBe(10);
  const result = await validateReferenceCases(evaluationCases);
  expect(result).toHaveLength(8);
  expect(result.every(r => r.initialFails && r.referencePasses)).toBe(true);
  expect(evaluationCases.filter(c => c.kind === 'grounding')).toHaveLength(2);
}, 30_000);

it('does not count an early successful process exit as a passing contract test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoq-early-exit-'));
  try {
    await writeCaseFixture(root, { ...evaluationCases[0].files, 'src/main.mjs': 'process.exit(0);\n' });
    expect((await gradeCase(evaluationCases[0], root)).functional).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('creates identical base commits for independent repetitions of the same task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoq-base-commit-'));
  try {
    const first = await initializeCaseRepository(join(root, 'first'), evaluationCases[0]);
    const second = await initializeCaseRepository(join(root, 'second'), evaluationCases[0]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{40}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
