import { relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const firstErrorLine = message => stripVTControlCharacters(String(message)).split('\n')[0];
const environmentFailure = /timed?\s+out|\btimeout(?:error)?\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|connection (?:refused|terminated|closed)|server closed the connection|out of memory|worker (?:exited|crashed)|socket hang up/i;
const key = (file, name) => JSON.stringify([file, name]);

/** Evidence must identify the reviewed behavioral failure, not merely a red run. */
export function evaluateRun({ mode, run, data, transformed, completion, witness, baseline, api }) {
  const tests = data?.testResults?.flatMap(suite => (suite.assertionResults ?? []).map(test => ({
    ...test, file: relative(api, suite.name).replaceAll('\\', '/'),
  }))) ?? [];
  const failed = tests.filter(test => test.status === 'failed');
  const passed = tests.filter(test => test.status === 'passed');
  const testKeys = tests.map(test => key(test.file, test.fullName)).sort();
  const result = { status: 'invalid-run', reason: '', testKeys, passed: passed.length, failed: failed.length,
    skipped: tests.length - passed.length - failed.length, failedTests: failed.map(test => test.fullName) };
  const invalid = reason => ({ ...result, reason });
  if (run.error || run.signal || ![0, 1].includes(run.status)) return invalid('abnormal-process-exit');
  if (!completion || completion.reason === 'interrupted' || completion.unhandledErrors?.length !== 0) return invalid('missing-or-unclean-completion');
  if (!transformed?.sites || transformed.mode !== (mode === 'recovery' ? 'baseline' : mode)) return invalid('missing-or-wrong-transform');
  if (!tests.length || new Set(testKeys).size !== tests.length || result.skipped || data.numPendingTests || data.numTodoTests) return invalid('missing-duplicate-or-skipped-tests');
  if (data.numPassedTests !== passed.length || data.numFailedTests !== failed.length || data.numTotalTests !== tests.length
    || data.testResults.some(suite => !suite.assertionResults?.length || !['passed', 'failed'].includes(suite.status))) return invalid('incomplete-test-report');
  const messages = [...failed.flatMap(test => test.failureMessages ?? []), ...data.testResults.map(suite => suite.message ?? '')];
  // Framework stacks contain names such as Timeout.checkCallback even for a
  // normal assertion mismatch. Keep error/cause diagnostics, omit stack frames.
  if (messages.some(message => environmentFailure.test(stripVTControlCharacters(String(message)).split('\n')
    .filter(line => !/^\s*at\s/.test(line)).join('\n')))) return invalid('environment-failure');
  if (baseline && JSON.stringify(testKeys) !== JSON.stringify(baseline.testKeys)) return invalid('baseline-test-set-changed');
  if (mode === 'baseline' || mode === 'recovery') {
    return run.status === 0 && data.success === true && completion.reason === 'passed' && !failed.length
      ? { ...result, status: 'passed', reason: 'clean-baseline' } : invalid('baseline-failed');
  }
  if (!baseline || baseline.status !== 'passed') return invalid('missing-clean-baseline');
  if (run.status === 0) return data.success === true && completion.reason === 'passed' && !failed.length
    ? { ...result, status: 'survived', reason: 'mutant-did-not-break-contract' } : invalid('inconsistent-exit');
  if (data.success !== false || completion.reason !== 'failed') return invalid('inconsistent-exit');
  const matched = failed.find(test => test.file === witness?.testFile && test.fullName === witness?.test
    && test.failureMessages?.some(message => firstErrorLine(message) === witness.error));
  return matched ? { ...result, status: 'detected', reason: 'reviewed-failure-witness', witness }
    : invalid('expected-failure-witness-missing');
}
