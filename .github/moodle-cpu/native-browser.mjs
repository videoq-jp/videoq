// Real Moodle-session requests for native acceptance. No VideoQ credential is
// available to the browser, and no HTTP response or authorization is replaced.
import assert from 'node:assert/strict';
const MOODLE = 'https://moodle.localhost:18443';

export async function selectQuestionLesson(ui, videoId) {
  await ui.locator('#videoq-qa-content form').getByLabel(/^(Lesson|教材)$/).selectOption(String(videoId));
}

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
  const rows = await response.json();
  return learningRow(rows[call.index]);
}
function learningRow(row) {
  assert(row && typeof row === 'object');
  if (row.error) {
    const code = row.exception?.errorcode;
    return {status: ['nativeaccessdenied', 'nopermissions'].includes(code) ? 403 :
      ['servicerequireslogin', 'requireloginerror', 'invalidsesskey', 'notloggedin'].includes(code) ? 401 : 503,
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

// Keep the exact pre-deletion Moodle cookie/CSRF/context only in this closure.
// core/ajax redirects on servicerequireslogin, destroying a page.evaluate()
// observer. Replay the original credential to the same real Moodle gateway,
// without minting a replacement session, bypassing checks or following redirects.
export async function captureOriginalNativeSession(page, {origin = MOODLE} = {}) {
  assert.equal(new URL(page.url()).origin, origin);
  const target = origin + '/lib/ajax/service.php';
  const bootstrap = await page.evaluate(() => {
    const root = document.querySelector('.local-videoq-workspace[data-videoq-native]');
    const config = JSON.parse(root.dataset.videoqConfig);
    return {courseid: config.courseid, lesson: config.lesson || '', sesskey: M.cfg.sesskey};
  });
  assert(Number.isSafeInteger(bootstrap.courseid) && bootstrap.courseid > 0);
  assert(typeof bootstrap.lesson === 'string' && /^[a-z0-9_-]{0,64}$/.test(bootstrap.lesson));
  assert(typeof bootstrap.sesskey === 'string' && bootstrap.sesskey.length > 0 && bootstrap.sesskey.length <= 128);
  const context = page.context(), cookies = await context.cookies(target);
  assert(cookies.some(cookie => cookie.name.startsWith('MoodleSession')), 'Original Moodle session cookie exists');
  const cookie = cookies.map(value => value.name + '=' + value.value).join('; ');
  return async (operation, payload = {}) => {
    assert(['conversations', 'qa'].includes(operation), 'Only the original-session denial probes use this transport');
    const response = await context.request.post(target, {maxRedirects: 0,
      params: {sesskey: bootstrap.sesskey, info: 'local_videoq_request_learning'},
      headers: {Cookie: cookie}, data: [{index: 0, methodname: 'local_videoq_request_learning',
        args: {courseid: bootstrap.courseid, lesson: bootstrap.lesson, operation, payload: JSON.stringify(payload)}}]});
    try {
      assert.equal(response.status(), 200, 'Actual Moodle AJAX envelope is required even for a refused session');
      const rows = await response.json();
      assert(Array.isArray(rows) && rows.length === 1);
      return learningRow(rows[0]);
    } finally {await response.dispose();}
  };
}

export async function installNativeReader(context, {origin = MOODLE} = {}) {
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
        ['servicerequireslogin', 'requireloginerror', 'invalidsesskey', 'notloggedin'].includes(error?.errorcode) ? 401 : 503,
        contenttype: 'application/json', body: '{"error":{"code":"MOODLE_REQUEST_FAILED"}}'}));
      if (result.contenttype !== 'application/json') throw new Error('Unexpected learning response format');
      return {status: result.status, body: JSON.parse(result.body)};
    };
  }, {origin});
}
