import assert, {AssertionError} from 'node:assert/strict';
import {test} from 'node:test';
import {AcceptanceCommandError, browserFailure, commandEvidence} from './browser-evidence.mjs';
import {observeMaintenanceFetch, serviceFailure} from './maintenance-observer.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {transportError} from './transport-probe.mjs';
import {fileURLToPath} from 'node:url';

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

test('Playwright filesystem frames identify the failing helper before its async caller', () => {
  const error = new Error('PRIVATE_SELECTOR');
  error.name = 'TimeoutError';
  const path = fileURLToPath(source);
  error.stack = `TimeoutError: PRIVATE_MESSAGE\n    at PRIVATE_FUNCTION (/private/PRIVATE_PATH.mjs:7:9)\n    at PRIVATE_HELPER (${path}:301:85)\n    at async ${source}:577:3`;
  assert.deepEqual(browserFailure(error, source), {kind: 'timeout', line: 301, column: 85});
  assert(!JSON.stringify(browserFailure(error, source)).includes('PRIVATE'));
  for (const frame of [`${path}.unreviewed:12:4`, `${path}:0:4`, `${path}:100001:4`]) {
    error.stack = `TimeoutError\n    at PRIVATE_HELPER (${frame})\n    at async ${source}:577:3`;
    assert.deepEqual(browserFailure(error, source), {kind: 'timeout', line: 577, column: 3});
  }
});

test('unrecognized thrown values and error names cannot become public strings', () => {
  for (const error of ['PRIVATE_VALUE', {name: 'PRIVATE_NAME', stack: 'PRIVATE_STACK'}, null])
    assert.deepEqual(browserFailure(error, source), {kind: 'error'});
  const error = new Error('PRIVATE_MESSAGE');
  error.name = 'PRIVATE_NAME';
  error.stack = 'PRIVATE_STACK';
  assert.deepEqual(browserFailure(error, source), {kind: 'error'});
});

test('command evidence reconstructs only known PHP labels and bounded integers', () => {
  const cause = new Error('PRIVATE_MESSAGE');
  cause.status = 1;
  cause.stderr = Buffer.from('PRIVATE_RAW\nVIDEOQ_CPU_FAILURE ' + JSON.stringify({kind: 'Error', source: 'fixture.php',
    line: 244, code: 'invalidconfiguration', message: 'PRIVATE_BODY', path: '/PRIVATE_PATH'}));
  const expected = {operation: 'moodle-tick', exitCode: 1,
    php: {kind: 'Error', source: 'fixture.php', line: 244, code: 'invalidconfiguration'}};
  assert.deepEqual(commandEvidence(cause, 'moodle-tick'), expected);
  const evidence = browserFailure(new AcceptanceCommandError(cause, 'moodle-tick'), import.meta.url);
  assert.deepEqual(evidence.command, expected);
  assert(!JSON.stringify(evidence).includes('PRIVATE'));
  for (const line of [true, 0, 100001, 'PRIVATE']) {
    cause.stderr = 'VIDEOQ_CPU_FAILURE ' + JSON.stringify({kind: 'PRIVATE', source: '/PRIVATE_PATH', line, code: 'PRIVATE'});
    assert.deepEqual(commandEvidence(cause, 'moodle-tick'), {operation: 'moodle-tick', exitCode: 1});
  }
  cause.status = true; cause.signal = 'PRIVATE'; cause.code = 'PRIVATE';
  assert.deepEqual(commandEvidence(cause, 'PRIVATE_OPERATION'), {operation: 'cluster-read'});
});

test('maintenance evidence excludes error messages and includes only failed fixed task names', () => {
  const stderr = 'PRIVATE_LOG\n' + JSON.stringify({event: 'scheduled_delivery_recovery',
    ltiMaterials: {error: 'LTI materials service unavailable'},
    health: {error: 'permission denied for table PRIVATE_TABLE'},
    externalTasks: {claimed: 0}, PRIVATE_TASK: {error: 'PRIVATE'}}) + '\nVIDEOQ_CPU_HTTP ' + JSON.stringify({
    service: 'moodle-oauth', httpStatus: 403, requestFailed: true, code: 'PRIVATE', body: 'PRIVATE'});
  const evidence = commandEvidence({status: 1, stderr}, 'backend-maintenance');
  assert.deepEqual(evidence, {operation: 'backend-maintenance', exitCode: 1,
    maintenance: [{task: 'ltiMaterials', reason: 'materials-service-unavailable'},
      {task: 'health', reason: 'database-permission-denied'}],
    http: {service: 'moodle-oauth', httpStatus: 403, requestFailed: true}});
  assert(!JSON.stringify(evidence).includes('PRIVATE'));
  for (const value of [null, [], {service: 'PRIVATE'}, {service: 'moodle-oauth', httpStatus: true},
    {service: 'moodle-oauth', httpStatus: 600, code: 'PRIVATE'}]) {
    assert.deepEqual(commandEvidence({stderr: 'VIDEOQ_CPU_HTTP ' + JSON.stringify(value)}, 'backend-maintenance'),
      {operation: 'backend-maintenance'});
  }
});

test('maintenance fetch observer returns the same real response without consuming its body', async () => {
  const response = new Response('PRIVATE_BODY', {status: 403});
  const request = new Request('https://moodle.localhost:18443/local/videoq/token.php?PRIVATE_QUERY', {
    method: 'POST', headers: {Authorization: 'Bearer PRIVATE'}, body: 'PRIVATE_BODY'});
  const options = {redirect: 'error'};
  const seen = [];
  const observed = observeMaintenanceFetch(async (input, received) => {
    assert.equal(input, request); assert.equal(received, options); return response;
  }, value => seen.push(value));
  assert.equal(await observed(request, options), response);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(seen, [{service: 'moodle-oauth', httpStatus: 403}]);
  assert(!JSON.stringify(seen).includes('PRIVATE'));
});

test('observer retains thrown identity and never exposes unknown endpoints or error details', async () => {
  const error = new Error('PRIVATE_ERROR', {cause: {code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'PRIVATE_CAUSE'}});
  const seen = [];
  const observed = observeMaintenanceFetch(async () => {throw error;}, value => seen.push(value));
  await assert.rejects(observed('https://moodle.localhost:18443/local/videoq/materials.php'), value => value === error);
  assert.deepEqual(seen, [{service: 'moodle-materials', requestFailed: true, requestKind: 'error', code: 'SELF_SIGNED_CERT_IN_CHAIN'}]);
  for (const input of ['https://PRIVATE.invalid/local/videoq/token.php', 'https://moodle.localhost:18443/PRIVATE',
    'PRIVATE', null]) assert.equal(serviceFailure(input, null, error), null);
  assert.deepEqual(serviceFailure('https://moodle.localhost:18443/local/videoq/token.php', null,
    {code: 'PRIVATE', cause: {code: 'PRIVATE'}}), {service: 'moodle-oauth', requestFailed: true, requestKind: 'error'});
  assert(!JSON.stringify(seen).includes('PRIVATE'));
});

test('actual Node preload forwards a real data fetch with no network or metadata output', () => {
  const preload = 'data:text/javascript;base64,' + readFileSync(new URL('./maintenance-observer.mjs', import.meta.url)).toString('base64');
  const code = 'const r = await fetch("data:text/plain,actual-fetch"); console.log(JSON.stringify({status:r.status,text:await r.text()}));';
  const output = execFileSync(process.execPath, ['--import', preload, '--input-type=module', '--eval', code], {
    env: {...process.env, VIDEOQ_MOODLE_CPU_OBSERVER: '1'}, encoding: 'utf8', timeout: 10_000,
  });
  assert.deepEqual(JSON.parse(output), {status: 200, text: 'actual-fetch'});
});

test('transport errors retain nested standard network codes and timeout class without private values', () => {
  const cause = new AggregateError([Object.assign(new Error('PRIVATE'), {code: 'EAI_AGAIN'}),
    Object.assign(new Error('PRIVATE'), {code: 'PRIVATE'})], 'PRIVATE');
  const error = new Error('PRIVATE', {cause}); error.name = 'TimeoutError';
  assert.deepEqual(transportError(error), {kind: 'timeout', codes: ['EAI_AGAIN']});
  assert.deepEqual(serviceFailure('https://moodle.localhost:18443/local/videoq/token.php', null, error),
    {service: 'moodle-oauth', requestFailed: true, requestKind: 'timeout', code: 'EAI_AGAIN'});
  assert(!JSON.stringify(transportError(error)).includes('PRIVATE'));
  cause.cause = cause;
  assert.deepEqual(transportError({name: 'PRIVATE', cause}), {kind: 'error', codes: ['EAI_AGAIN']});
  assert.deepEqual(transportError('PRIVATE'), {kind: 'error', codes: []});
});
