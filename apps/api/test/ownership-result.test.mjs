import { describe, expect, it } from 'vitest';
import { evaluateRun } from '../scripts/ownership/result.mjs';

const witness = { testFile: 'test/contract.test.ts', test: 'rejects invalid input', error: 'AssertionError: expected true to be false' };
function evidence(mode = 'bypass') {
  const failed = !['baseline', 'recovery'].includes(mode);
  return { mode, api: '/repo/apps/api', run: { status: failed ? 1 : 0, signal: null },
    transformed: { sites: 1, mode: mode === 'recovery' ? 'baseline' : mode },
    completion: { reason: failed ? 'failed' : 'passed', unhandledErrors: [] }, witness,
    data: { success: !failed, numTotalTests: 1, numPassedTests: failed ? 0 : 1,
      numFailedTests: failed ? 1 : 0, numPendingTests: 0, numTodoTests: 0,
      testResults: [{ name: '/repo/apps/api/test/contract.test.ts', status: failed ? 'failed' : 'passed',
        assertionResults: [{ fullName: witness.test, status: failed ? 'failed' : 'passed',
          failureMessages: failed ? [witness.error] : [] }] }] } };
}
const baseline = evaluateRun(evidence('baseline'));
const mutate = () => ({ ...evidence(), baseline });

describe('ownership failure attribution', () => {
  it('requires the reviewed failure in a test that passed in the baseline', () => {
    expect(evaluateRun(mutate())).toMatchObject({ status: 'detected', reason: 'reviewed-failure-witness' });
    expect(evaluateRun({ ...evidence('recovery'), baseline })).toMatchObject({ status: 'passed' });
  });
  it('does not mistake the test framework timeout wrapper in a stack for a timeout error', () => {
    const input = mutate();
    input.data.testResults[0].assertionResults[0].failureMessages[0] += '\n    at runWithTimeout (vitest.js:1:2)\n    at Timeout.checkCallback (vitest.js:2:3)';
    expect(evaluateRun(input).status).toBe('detected');
  });
  it.each(['Test timed out in 5000ms', 'Error: connect ECONNREFUSED 127.0.0.1:5432', 'Error: socket hang up',
    'Error: server closed the connection unexpectedly', 'Error: Unknown provider failure'])('rejects an unrelated failure: %s', message => {
    const input = mutate(); input.data.testResults[0].assertionResults[0].failureMessages = [message];
    expect(evaluateRun(input).status).toBe('invalid-run');
  });
  it('rejects environment failure even alongside the reviewed assertion', () => {
    const input = mutate(); input.data.testResults[0].assertionResults[0].failureMessages.push('Error: connect ECONNRESET');
    expect(evaluateRun(input).reason).toBe('environment-failure');
  });
  it.each([
    ['a killed process', input => { input.run.status = null; input.run.signal = 'SIGKILL'; }],
    ['a process error', input => { input.run.error = new Error('spawn failed'); }],
    ['a crash exit', input => { input.run.status = 137; }],
    ['a missing completion receipt', input => { input.completion = null; }],
    ['interruption', input => { input.completion.reason = 'interrupted'; }],
    ['an unhandled error', input => { input.completion.unhandledErrors = [{ message: 'unhandled rejection' }]; }],
    ['a missing transform', input => { input.transformed = null; }],
    ['the wrong transform', input => { input.transformed.mode = 'baseline'; }],
    ['a missing witness', input => { input.witness = null; }],
    ['the wrong failure reason', input => { input.witness = { ...witness, error: 'AssertionError: other' }; }],
    ['a different test', input => { input.data.testResults[0].assertionResults[0].fullName = 'unrelated test'; }],
    ['a missing baseline', input => { input.baseline = null; }],
    ['a skipped test', input => { input.data.numPendingTests = 1; }],
    ['a collection failure', input => { input.data.testResults.push({ name: '/repo/apps/api/test/broken.test.ts', status: 'failed', assertionResults: [] }); }],
    ['an inconsistent report', input => { input.data.numFailedTests = 0; }],
    ['an inconsistent exit', input => { input.run.status = 0; }],
  ])('fails closed for %s', (_label, change) => {
    const input = mutate(); change(input);
    expect(evaluateRun(input).status).toBe('invalid-run');
  });
  it('does not call a surviving mutant detected', () => {
    const input = { ...evidence('baseline'), mode: 'bypass', transformed: { sites: 1, mode: 'bypass' }, baseline, witness };
    expect(evaluateRun(input).status).toBe('survived');
  });
  it('requires the recovery baseline to pass and retain the original test set', () => {
    const input = { ...evidence(), mode: 'recovery', transformed: { sites: 1, mode: 'baseline' }, baseline };
    expect(evaluateRun(input).status).toBe('invalid-run');
    const changed = { ...evidence('recovery'), baseline };
    changed.data.testResults[0].assertionResults[0].fullName = 'replacement';
    expect(evaluateRun(changed).reason).toBe('baseline-test-set-changed');
  });
});
