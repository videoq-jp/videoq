// Real Moodle-session requests for native acceptance. No VideoQ credential is
// available to the browser, and no HTTP response or authorization is replaced.
import assert from 'node:assert/strict';
const MOODLE = 'https://moodle.localhost:18443';

export function learningCalls(request) {
  try {
    const url = new URL(request.url());
    if (url.origin !== MOODLE || url.pathname !== '/lib/ajax/service.php' || request.method() !== 'POST') return [];
    const calls = request.postDataJSON();
    if (!Array.isArray(calls)) return [];
    return calls.map((call, index) => {
      if (call?.methodname !== 'local_videoq_request_learning' || !call.args || typeof call.args.payload !== 'string') return null;
      const payload = JSON.parse(call.args.payload);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      return {index, operation: call.args.operation, action: payload.action};
    }).filter(Boolean);
  } catch {return [];}
}
export function matchesLearningResponse(response, operation, action) {
  return learningCalls(response.request()).some(call => call.operation === operation &&
    (action === undefined || call.action === action));
}
export async function learningResponse(response, operation, action) {
  const call = learningCalls(response.request()).find(call => call.operation === operation &&
    (action === undefined || call.action === action));
  assert(call, 'Actual Moodle core AJAX operation is present');
  assert.equal(response.status(), 200, 'Moodle serves the session-authenticated AJAX envelope');
  const rows = await response.json(), row = rows[call.index];
  assert(row && typeof row === 'object');
  if (row.error) {
    const code = row.exception?.errorcode;
    return {status: ['nativeaccessdenied', 'nopermissions'].includes(code) ? 403 :
      ['requireloginerror', 'invalidsesskey', 'notloggedin'].includes(code) ? 401 : 503,
      body: {error: {code: 'MOODLE_REQUEST_FAILED'}}};
  }
  assert(Number.isInteger(row.data?.status) && row.data.status >= 200 && row.data.status <= 599);
  assert.equal(row.data.contenttype, 'application/json');
  return {status: row.data.status, body: JSON.parse(row.data.body)};
}
export async function waitLearningResponse(page, operation, action) {
  const response = await page.waitForResponse(response => matchesLearningResponse(response, operation, action));
  return learningResponse(response, operation, action);
}
export async function installNativeReader(context) {
  await context.addInitScript(({origin}) => {
    if (location.origin !== origin) return;
    window.__cpuRead = async (operation, payload = {}) => {
      if (!['materials', 'transcript', 'history', 'reports', 'tags', 'qa', 'management', 'conversations', 'feedback'].includes(operation))
        throw new Error('Unknown native learning operation');
      const root = document.querySelector('.local-videoq-workspace[data-videoq-native]');
      if (!root || typeof window.require !== 'function') throw new Error('Native Moodle learning page unavailable');
      const config = JSON.parse(root.dataset.videoqConfig);
      const result = await new Promise((resolve, reject) => window.require(['core/ajax'], Ajax => {
        Ajax.call([{methodname: 'local_videoq_request_learning', args: {courseid: config.courseid,
          lesson: config.lesson || '', operation, payload: JSON.stringify(payload)}}])[0].then(resolve, reject);
      })).catch(error => ({status: ['nativeaccessdenied', 'nopermissions'].includes(error?.errorcode) ? 403 :
        ['requireloginerror', 'invalidsesskey', 'notloggedin'].includes(error?.errorcode) ? 401 : 503,
        contenttype: 'application/json', body: '{"error":{"code":"MOODLE_REQUEST_FAILED"}}'}));
      if (result.contenttype !== 'application/json') throw new Error('Unexpected learning response format');
      return {status: result.status, body: JSON.parse(result.body)};
    };
  }, {origin: MOODLE});
}
