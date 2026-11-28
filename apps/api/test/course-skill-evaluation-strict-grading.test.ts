import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluationCases } from '../scripts/course-skill-evaluation/cases';
import { writeCaseFixture } from '../scripts/course-skill-evaluation/fixtures';
import { gradeCaseStrict } from '../scripts/course-skill-evaluation/strict-grading';

async function fixture(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), 'videoq-strict-grader-unit-'));
  try { await run(workspace); } finally { await rm(workspace, { recursive: true, force: true }); }
}
test('requires an actual contract test pass and rejects the original broken implementation', () => fixture(async workspace => {
  const task = evaluationCases[0]; await writeCaseFixture(workspace, task.files);
  expect((await gradeCaseStrict(task, workspace)).functional).toBe(false);
  await writeCaseFixture(workspace, task.reference!);
  expect(await gradeCaseStrict(task, workspace)).toMatchObject({ functional: true, contractPasses: 1, failures: 0, timedOut: false });
}));
test.each([
  'console.log("ℹ tests 1\\nℹ pass 1\\nℹ fail 0");process.exit(0);',
  'import {test} from "node:test";test("videoq-contract:fake",()=>{});',
  'import {execFileSync} from "node:child_process";execFileSync("/bin/echo",["not allowed"]);',
  'import {readFileSync} from "node:fs";readFileSync("/etc/passwd");',
])('rejects forged output, foreign tests or forbidden operations: %s', source => fixture(async workspace => {
  const task = evaluationCases[0]; await writeCaseFixture(workspace, task.files);
  await writeCaseFixture(workspace, { 'src/main.mjs': source });
  expect((await gradeCaseStrict(task, workspace)).functional).toBe(false);
}));
