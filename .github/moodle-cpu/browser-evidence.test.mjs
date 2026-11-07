import assert, {AssertionError} from 'node:assert/strict';
import {test} from 'node:test';
import {AcceptanceCommandError, browserFailure, clickActionabilityEvidence, commandEvidence, mediaRangeEvidence, tagUiEvidence} from './browser-evidence.mjs';
import {observeMaintenanceFetch, serviceFailure} from './maintenance-observer.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {transportError} from './transport-probe.mjs';
import {fileURLToPath} from 'node:url';
import {suppressedMailContinuation} from './privacy.mjs';

const source = new URL('./acceptance.mjs', import.meta.url).href;
test('mail-suppressed core requests follow only the expected Moodle Continue destination', () => {
  const current = 'https://moodle.localhost:18443/admin/tool/dataprivacy/createdatarequest.php?manage=0&type=1';
  const target = 'https://moodle.localhost:18443/admin/tool/dataprivacy/mydatarequests.php';
  const warning = 'Not sending email due to $CFG->noemailever config setting\nPRIVATE_BACKTRACE';
  assert.equal(suppressedMailContinuation(current, target, [warning]), target);
  assert.equal(suppressedMailContinuation(current, 'mydatarequests.php', [warning, warning]), target);
});
test('core request continuation rejects foreign destinations, missing warnings and unrelated errors', () => {
  const current = 'https://moodle.localhost:18443/admin/tool/dataprivacy/createdatarequest.php';
  const target = 'https://moodle.localhost:18443/admin/tool/dataprivacy/mydatarequests.php';
  const warning = 'Not sending email due to $CFG->noemailever config setting';
  for (const [url, href, warnings] of [
    [current.replace('moodle.localhost', 'foreign.localhost'), target, [warning]],
    [current.replace('createdatarequest', 'datarequests'), target, [warning]],
    [current, target.replace('moodle.localhost', 'foreign.localhost'), [warning]],
    [current, target + '?PRIVATE', [warning]], [current, null, [warning]],
    [current, target, []], [current, target, [warning, 'PRIVATE_ERROR']],
    [current, target, [true]], [current, target, Array(17).fill(warning)]])
    assert.throws(() => suppressedMailContinuation(url, href, warnings));
});
test('media range diagnostics retain bounded transport facts without headers or response bodies', () => {
  const facts = {httpStatus: 206, bodyBytes: 16, declaredBytes: 16, offloaded: true,
    rangeMatches: true, mp4Prefix: true, htmlLike: false, developerWarning: false,
    contentKind: 'video', encoding: 'identity'};
  assert.deepEqual(mediaRangeEvidence({...facts, url: 'PRIVATE_URL', headers: {cookie: 'PRIVATE_COOKIE'},
    body: 'PRIVATE_BODY', error: 'PRIVATE_ERROR'}), facts);
  assert.deepEqual(mediaRangeEvidence(mediaRangeEvidence(facts)), facts);
});
test('media range diagnostics reject invalid numeric values, types and unrecognized text', () => {
  for (const value of [null, [], 'PRIVATE', {httpStatus: true, bodyBytes: 'PRIVATE', declaredBytes: Infinity,
    offloaded: 'PRIVATE', contentKind: 'PRIVATE', encoding: 'PRIVATE'},
  {httpStatus: 600, bodyBytes: -1, declaredBytes: 100_000_001, rangeMatches: 1}])
    assert.deepEqual(mediaRangeEvidence(value), {});
  assert.deepEqual(mediaRangeEvidence({httpStatus: 206, bodyBytes: 0, declaredBytes: 16,
    offloaded: false, htmlLike: true, developerWarning: true, contentKind: 'html', encoding: 'gzip'}),
  {httpStatus: 206, bodyBytes: 0, declaredBytes: 16, offloaded: false,
    htmlLike: true, developerWarning: true, contentKind: 'html', encoding: 'gzip'});
});
test('click actionability excludes private Playwright selectors and intercepted markup', () => {
  const error = new Error('PRIVATE_SELECTOR\nPRIVATE_HTML intercepts pointer events\nretrying click action\n' +
    'element is not stable\ndone scrolling\nhttps://PRIVATE_URL/?token=PRIVATE_TOKEN');
  const value = clickActionabilityEvidence(error);
  assert.equal(value.pointerIntercepted, true);
  assert.equal(value.unstable, true);
  assert.equal(value.scrolled, true);
  assert.equal(value.retrying, true);
  assert.equal(value.outsideViewport, false);
  assert.deepEqual(clickActionabilityEvidence({...value, message: 'PRIVATE', raw: 'PRIVATE'}), value);
  assert(!JSON.stringify(value).includes('PRIVATE'));
  for (const input of [null, [], 'PRIVATE', {message: 'PRIVATE', unstable: 1},
    Object.assign(new Error('PRIVATE'), {message: {raw: 'PRIVATE'}})])
    assert.deepEqual(clickActionabilityEvidence(input), {});
});
test('native hit testing retains only bounded positions and fixed target classes', () => {
  const value = {teacher: {frameX: -10, buttonTop: 520, panelScrollTop: 0, panelScrollHeight: 750,
    privateHitButton: false, targetInFrameViewport: false, parentHitTarget: 'header', centerY: 'PRIVATE', html: 'PRIVATE'},
  learner: {frameY: -100001, panelClientHeight: true, openDialogs: 100001, parentHitTarget: 'PRIVATE', frameActive: 'PRIVATE'}};
  assert.deepEqual(tagUiEvidence(value), {teacher: {privateHitButton: false, targetInFrameViewport: false,
    panelScrollHeight: 750, panelScrollTop: 0, frameX: -10, buttonTop: 520, parentHitTarget: 'header'}});
  assert(!JSON.stringify(tagUiEvidence(value)).includes('PRIVATE'));
});
test('structured Playwright logs and navigation observations never expose their private strings', () => {
  const error = new Error('Timeout');
  error.log = ['waiting for locator(PRIVATE_SELECTOR)', 'locator resolved to PRIVATE_HTML',
    'waiting for "https://PRIVATE_URL/?token=PRIVATE" navigation to finish...', 'PRIVATE_BODY'];
  const value = clickActionabilityEvidence(error);
  assert.equal(value.waitingForLocator, true); assert.equal(value.resolvedElement, true);
  assert.equal(value.waitingForNavigation, true); assert.equal(value.logLines, 4);
  assert(!JSON.stringify(value).includes('PRIVATE'));
  assert.deepEqual(clickActionabilityEvidence({...value, log: error.log, raw: 'PRIVATE'}), value);
  assert.deepEqual(tagUiEvidence({teacher: {parentDocumentsStarted: 4, parentDocumentsPending: 1,
    parentDocumentKind: 'lesson', parentDocumentState: 'interactive', url: 'PRIVATE'},
  learner: {parentDocumentsFailed: true, parentDocumentsFinished: 100001,
    parentDocumentKind: 'PRIVATE', parentDocumentState: 'PRIVATE'}}),
  {teacher: {parentDocumentsStarted: 4, parentDocumentsPending: 1, parentDocumentKind: 'lesson', parentDocumentState: 'interactive'}});
});
test('native tag diagnostics retain bounded UI and current catalog facts without private content', () => {
  const value = {teacher: {buttonHidden: false, buttonDisabled: true, nativeMode: true,
    frameHeight: 512, buttonWidth: 90, html: 'PRIVATE_HTML', token: 'PRIVATE_TOKEN',
    catalog: {status: 200, canManage: true, tags: 0, videos: 1, body: 'PRIVATE_BODY'}},
  learner: {buttonHidden: true, catalog: {status: 403, canManage: 'PRIVATE', tags: 0}},
  PRIVATE_ROLE: {body: 'PRIVATE'}};
  assert.deepEqual(tagUiEvidence(value), {teacher: {buttonHidden: false, buttonDisabled: true, nativeMode: true,
    frameHeight: 512, buttonWidth: 90, catalog: {status: 200, canManage: true, tags: 0, videos: 1}},
  learner: {buttonHidden: true, catalog: {status: 403}}});
  for (const invalid of [null, [], {teacher: {buttonHidden: 'PRIVATE', buttonWidth: true, frameHeight: 100001,
    catalog: {status: true, canManage: true, tags: 1}}}]) assert.deepEqual(tagUiEvidence(invalid), {});
  assert.deepEqual(tagUiEvidence({teacher: {catalog: {timedOut: true, requestFailed: 'PRIVATE'}}}),
    {teacher: {catalog: {timedOut: true}}});
});
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

test('privacy commands expose fixed metadata without archive records or raw task logs', () => {
  const cause = {status: 1, stderr: 'PRIVATE_TASK_LOG\nVIDEOQ_CPU_FAILURE ' + JSON.stringify({
    kind: 'RuntimeException', source: 'privacy-fixture.php', line: 81, message: 'PRIVATE_ARCHIVE_RECORD'})};
  assert.deepEqual(commandEvidence(cause, 'moodle-privacy-task'), {operation: 'moodle-privacy-task', exitCode: 1,
    php: {kind: 'RuntimeException', source: 'privacy-fixture.php', line: 81}});
  assert.deepEqual(commandEvidence({status: 1, stdout: 'PRIVATE_MODEL_RECORD'}, 'privacy-archive-evidence'),
    {operation: 'privacy-archive-evidence', exitCode: 1});
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
