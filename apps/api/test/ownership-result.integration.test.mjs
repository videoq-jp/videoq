import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { evaluateRun } from '../scripts/ownership/result.mjs';

it('distinguishes actual Vitest assertion, timeout, connection and unhandled failures', () => {
  const api = fileURLToPath(new URL('../', import.meta.url));
  const directory = mkdtempSync(resolve(tmpdir(), 'videoq-ownership-classification-'));
  const witness = { testFile: 'test/fixtures/ownership-result.fixture.mjs', test: 'enforces the reviewed contract',
    error: 'AssertionError: expected true to be false // Object.is equality' };
  let baseline;
  try {
    for (const scenario of ['baseline', 'assertion', 'timeout', 'connection', 'unhandled', 'recovery']) {
      const json = resolve(directory, `${scenario}.json`), receipt = resolve(directory, `${scenario}.completion.json`);
      const run = spawnSync(process.execPath, [resolve(api, '../../node_modules/vitest/vitest.mjs'), 'run',
        '--config', 'test/helpers/ownership-result.config.mjs', '--reporter=json',
        `--reporter=${resolve(api, 'scripts/ownership/completion-reporter.mjs')}`, `--outputFile=${json}`], {
        cwd: api, env: { ...process.env, OWNERSHIP_FAILURE_FIXTURE: scenario, OWNERSHIP_COMPLETION_RECEIPT: receipt },
        encoding: 'utf8', timeout: 30_000,
      });
      const mode = ['baseline', 'recovery'].includes(scenario) ? scenario : 'bypass';
      const result = evaluateRun({ mode, run, api, baseline, witness,
        data: existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : null,
        completion: existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : null,
        transformed: { sites: 1, mode: mode === 'recovery' ? 'baseline' : mode } });
      expect(result.status, `${scenario}: ${JSON.stringify(result)}\n${run.stderr}`).toBe(
        scenario === 'assertion' ? 'detected' : ['baseline', 'recovery'].includes(scenario) ? 'passed' : 'invalid-run');
      if (scenario === 'baseline') baseline = result;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
