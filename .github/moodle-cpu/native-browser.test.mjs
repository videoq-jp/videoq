import assert from 'node:assert/strict';
import test from 'node:test';
import {learningCalls, matchesLearningResponse, learningResponse, installNativeReader} from './native-browser.mjs';
const url = 'https://moodle.localhost:18443/lib/ajax/service.php?sesskey=owned-fixture';
const call = (operation, payload = {}) => ({methodname: 'local_videoq_request_learning',
  args: {courseid: 42, operation, lesson: 'sync_11', payload: JSON.stringify(payload)}});
const request = (calls, target = url, method = 'POST') => ({url: () => target, method: () => method, postDataJSON: () => calls});
const response = (calls, rows, status = 200) => ({request: () => request(calls), status: () => status, json: async () => rows});

test('native acceptance matches only exact Moodle gateway operations and actions', () => {
  const calls = [call('materials'), call('management', {action: 'update'})];
  assert.deepEqual(learningCalls(request(calls)), [{index: 0, operation: 'materials', action: undefined},
    {index: 1, operation: 'management', action: 'update'}]);
  assert.equal(matchesLearningResponse(response(calls), 'management', 'update'), true);
  assert.equal(matchesLearningResponse(response(calls), 'management', 'get'), false);
  for (const target of ['https://videoq.localhost:18443/lib/ajax/service.php', 'https://moodle.localhost:18443/api/lti/management'])
    assert.deepEqual(learningCalls(request(calls, target)), []);
  assert.deepEqual(learningCalls(request(calls, url, 'GET')), []);
  assert.deepEqual(learningCalls(request([{...call('materials'), methodname: 'foreign_function'}])), []);
  assert.deepEqual(learningCalls(request([{...call('materials'), args: {payload: '[]'}}])), []);
});

test('actual gateway envelope keeps the matching batch position and domain status', async () => {
  const r = response([call('materials'), call('management', {action: 'update'})], [
    {error: false, data: {status: 200, contenttype: 'application/json', body: '{"nativeProtocol":1}'}},
    {error: false, data: {status: 409, contenttype: 'application/json', body: '{"error":{"code":"REVISION_CONFLICT"}}'}},
  ]);
  assert.deepEqual(await learningResponse(r, 'management', 'update'), {status: 409, body: {error: {code: 'REVISION_CONFLICT'}}});
});

test('Moodle capability refusals retain 403 while private exception details are discarded', async () => {
  for (const code of ['nativeaccessdenied', 'nopermissions']) {
    const r = response([call('reports')], [{error: true, exception: {errorcode: code, message: 'private-fixture-detail', stacktrace: 'private-fixture-stack'}}]);
    assert.deepEqual(await learningResponse(r, 'reports'), {status: 403, body: {error: {code: 'MOODLE_REQUEST_FAILED'}}});
  }
});

test('login and gateway failures are not mistaken for domain success', async () => {
  assert.equal((await learningResponse(response([call('materials')], [{error: true, exception: {errorcode: 'requireloginerror'}}]), 'materials')).status, 401);
  assert.equal((await learningResponse(response([call('materials')], [{error: true, exception: {errorcode: 'unknown'}}]), 'materials')).status, 503);
  await assert.rejects(learningResponse(response([call('materials')], [], 500), 'materials'));
  await assert.rejects(learningResponse(response([call('materials')], [{data: {status: 200, contenttype: 'text/html', body: '<html>'}}]), 'materials'));
});

test('reader installation does not intercept fetch or expose a VideoQ bearer', async () => {
  let installed;
  await installNativeReader({addInitScript: async (fn, options) => {installed = {source: String(fn), options};}});
  assert.equal(installed.options.origin, 'https://moodle.localhost:18443');
  assert(installed.source.includes('core/ajax') && installed.source.includes('local_videoq_request_learning'));
  for (const forbidden of ['Authorization', 'window.fetch', 'postMessage', '/api/lti/', 'browserSecret'])
    assert.equal(installed.source.includes(forbidden), false);
});
