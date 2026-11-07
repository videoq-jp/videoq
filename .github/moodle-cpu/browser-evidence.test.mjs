import assert, {AssertionError} from 'node:assert/strict';
import {test} from 'node:test';
import {browserFailure} from './browser-evidence.mjs';

const source = new URL('./acceptance.mjs', import.meta.url).href;
test('a real Node assertion yields only its own numeric source location', () => {
  try {
    assert.fail('PRIVATE_ASSERTION');
  } catch (error) {
    const evidence = browserFailure(error, import.meta.url);
    assert.equal(evidence.kind, 'assertion');
    assert(Number.isInteger(evidence.line) && evidence.line > 0);
    assert(Number.isInteger(evidence.column) && evidence.column > 0);
    assert.deepEqual(Object.keys(evidence).sort(), ['column', 'kind', 'line']);
  }
});

test('public browser evidence excludes private messages, HTTP bodies and foreign stack paths', () => {
  const error = new AssertionError({message: 'PRIVATE_MESSAGE', actual: 'PRIVATE_BODY', expected: 'PRIVATE_EXPECTATION'});
  error.cause = new Error('PRIVATE_CAUSE');
  error.stack = `AssertionError: PRIVATE_MESSAGE\n    at PRIVATE_FUNCTION (file:///private/PRIVATE_PATH.mjs:7:9)\n    at async test (${source}:213:10)`;
  assert.deepEqual(browserFailure(error, source), {kind: 'assertion', line: 213, column: 10});
  assert(!JSON.stringify(browserFailure(error, source)).includes('PRIVATE'));
});

test('timeout evidence requires an own-source stack frame and bounded positive coordinates', () => {
  const error = new Error('PRIVATE_SELECTOR');
  error.name = 'TimeoutError';
  for (const stack of [`TimeoutError: ${source}:12:4`,
    `TimeoutError\n    at test (${source}.unreviewed:12:4)`,
    `TimeoutError\n    at test (${source}:0:4)`,
    `TimeoutError\n    at test (${source}:100001:4)`]) {
    error.stack = stack;
    assert.deepEqual(browserFailure(error, source), {kind: 'timeout'});
  }
  error.stack = `TimeoutError\n    at ${source}:194:2`;
  assert.deepEqual(browserFailure(error, source), {kind: 'timeout', line: 194, column: 2});
});

test('unrecognized thrown values and error names cannot become public strings', () => {
  for (const error of ['PRIVATE_VALUE', {name: 'PRIVATE_NAME', stack: 'PRIVATE_STACK'}, null])
    assert.deepEqual(browserFailure(error, source), {kind: 'error'});
  const error = new Error('PRIVATE_MESSAGE');
  error.name = 'PRIVATE_NAME';
  error.stack = 'PRIVATE_STACK';
  assert.deepEqual(browserFailure(error, source), {kind: 'error'});
});
