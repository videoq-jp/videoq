// Actual browser + Moodle core + VideoQ + CPU inference. No HTTP/AI responses
// are substituted. All identities/media belong to the disposable parent lab.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {browserFailure} from './browser-evidence.mjs';

const MOODLE = 'https://moodle.localhost:18443';
const VIDEOQ = 'https://videoq.localhost:18443';
const allowedOrigins = new Set([MOODLE, VIDEOQ, 'https://storage.videoq.localhost:18443']);
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sentinel = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const resultPath = process.argv[4];
const owner = process.env.MOODLE_CPU_OWNER;
const embeddingTable = process.env.MOODLE_CPU_EMBEDDING_TABLE;
assert(['scene_embeddings', 'scene_embeddings_768'].includes(embeddingTable));
assert.match(owner ?? '', /^[a-f0-9]{32}$/);
assert.equal(state.owner, owner);
for (const value of [state.courseId, state.cmid, sentinel.videoId, sentinel.courseId]) assert(Number.isSafeInteger(value) && value > 0);
assert.equal(new URL(state.lessonUrl).origin, MOODLE);
assert.equal(new URL(state.manageUrl).origin, MOODLE);
const prefix = ['--kubeconfig', process.env.MOODLE_CPU_KUBECONFIG, '--context', 'kind-videoq-onprem-lab', '-n', 'videoq-validation'];
const report = {status: 'running', stage: 'startup', phases: []};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function stage(name) {
  report.stage = name;
  writeFileSync(join(dirname(resultPath), 'moodle-stage.json'), JSON.stringify({stage: name, completed: report.phases}) + '\n');
}
function k(args, input) {
  return execFileSync('kubectl', [...prefix, ...args], {encoding: 'utf8', input, timeout: 120_000, maxBuffer: 2_000_000});
}
function requireOwner() {
  const marker = JSON.parse(k(['get', 'configmap', 'videoq-moodle-cpu-owner', '-o', 'json']));
  assert.equal(marker.data.owner, owner);
  assert.equal(marker.metadata.labels['jp.videoq.moodle-cpu-owner'], owner);
}
function fixture(action) {
  assert(['status', 'tick', 'hide', 'show', 'suspend', 'resume', 'deny-reports', 'allow-reports'].includes(action));
  requireOwner();
  return JSON.parse(k(['exec', 'deployment/moodle', '--', 'php', '/acceptance/fixture.php', action]));
}
function maintenance() {
  requireOwner();
  // This CLI operates only on the parent's isolated synthetic database. It runs
  // inside the CA-mounted actual API container, with the real runtime config.
  k(['exec', 'deployment/videoq-api', '--', 'node', 'dist/node.mjs', 'maintenance']);
}
function material() {
  requireOwner();
  // Baseline lifecycle restored the application into this separate DB. This is
  // read-only evidence; no status, transcript, vector or job row is fabricated.
  const sql = `SELECT row_to_json(t) FROM (SELECT v.id::int AS "videoId",r.course_id::int AS "courseId",v.status,
    v.transcript,(SELECT count(*)::int FROM ${embeddingTable} e WHERE e.video_id=v.id) AS "vectorCount",
    (SELECT count(*)::int FROM video_transcription_chunks c JOIN video_transcription_runs x ON x.run_id=c.run_id
      WHERE x.video_id=v.id AND c.segments IS NOT NULL) AS "asrChunks"
    FROM lms_resources r JOIN lms_installations i ON i.id=r.installation_id JOIN videos v ON v.id=r.video_id
    WHERE i.issuer='${MOODLE}' AND r.context_id='${state.courseId}' AND r.kind='video'
      AND r.enabled=true AND v.managed_by_lms=true) t;`;
  const raw = k(['exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-d', 'restored', '-At', '-v', 'ON_ERROR_STOP=1'], sql).trim();
  if (!raw) return null;
  const lines = raw.split('\n');
  assert.equal(lines.length, 1, 'Exactly the owned Moodle File must be managed');
  return JSON.parse(lines[0]);
}

const browser = await chromium.launch({headless: true});
async function context() {
  // The browser context is restricted to three known loopback fixture origins.
  // PHP and API use the actual trusted CA for all server-to-server requests;
  // the browser's local self-signed exception is isolated to this test context.
  const ctx = await browser.newContext({ignoreHTTPSErrors: true, locale: 'en-US',
    viewport: {width: 390, height: 844}, serviceWorkers: 'block', acceptDownloads: true});
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    return allowedOrigins.has(url.origin) || ['data:', 'about:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient');
  });
  await ctx.addInitScript(({origin}) => {
    if (location.origin === origin) {
      // Observe the real credential without exporting it from the private frame.
      // Direct denial probes call the original fetch against fixed feature APIs;
      // no response or authorization outcome is mocked or replaced.
      const original = window.fetch.bind(window);
      let bearer = null;
      window.fetch = (input, options = {}) => {
        const target = new URL(typeof input === 'string' ? input : input.url, location.href);
        const credential = new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined)).get('Authorization');
        if (target.origin === origin && target.pathname.startsWith('/api/lti/') && credential?.startsWith('Bearer ')) bearer = credential;
        return original(input, options);
      };
      window.__cpuRead = async (path, payload) => {
        if (!['reports', 'transcript', 'tags', 'qa'].includes(path) || !bearer) throw new Error('Private feature request unavailable');
        const response = await original('/api/lti/' + path, {method: 'POST', credentials: 'omit',
          headers: {'Content-Type': 'application/json', Authorization: bearer}, body: JSON.stringify(payload)});
        return {status: response.status, body: await response.json()};
      };
    }
    window.addEventListener('message', event => {
      if (event.origin !== origin || event.source !== document.querySelector('#videoq-questions')?.contentWindow) return;
      const data = event.data;
      if (data?.type === 'videoq:ready' && data.version === 1) window.__cpuBridge = data;
    });
  }, {origin: VIDEOQ});
  return ctx;
}
async function login(ctx, username) {
  const page = await ctx.newPage();
  await page.goto(MOODLE + '/login/index.php');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(state.password);
  await Promise.all([page.waitForURL(url => !url.pathname.includes('/login/')), page.locator('#loginbtn').click()]);
  return page;
}
async function privateFrame(page) {
  await page.waitForFunction(() => Number.isSafeInteger(window.__cpuBridge?.videoId), null, {timeout: 60_000});
  const frame = page.frames().find(frame => {
    try {const url = new URL(frame.url()); return url.origin === VIDEOQ && url.pathname.startsWith('/api/lti/');}
    catch {return false;}
  });
  assert(frame, 'Actual signed private LTI frame is present');
  return frame;
}
async function materials(page, action = 'list', targetVideoId) {
  return page.evaluate(({origin, action, targetVideoId}) => new Promise((resolve, reject) => {
    const frame = document.querySelector('#videoq-questions');
    const bridge = window.__cpuBridge;
    const requestId = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
    const timer = setTimeout(() => {removeEventListener('message', receive); reject(new Error('Material bridge deadline'));}, 35_000);
    function receive(event) {
      const data = event.data;
      if (event.source !== frame.contentWindow || event.origin !== origin || data?.type !== 'videoq:materials-result'
        || data.channel !== bridge.channel || data.requestId !== requestId) return;
      clearTimeout(timer); removeEventListener('message', receive); resolve(data);
    }
    addEventListener('message', receive);
    frame.contentWindow.postMessage({type: 'videoq:materials', version: 1, channel: bridge.channel,
      videoId: bridge.videoId, requestId, action, targetVideoId}, origin);
  }), {origin: VIDEOQ, action, targetVideoId});
}
async function uiAction(page, feature, action, click) {
  assert(['tags', 'qa'].includes(feature));
  const [response] = await Promise.all([page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/lti/' + feature || response.request().method() !== 'POST') return false;
    try {return response.request().postDataJSON()?.action === action;} catch {return false;}
  }), click()]);
  assert.equal(response.status(), 200, 'Actual course UI operation succeeds');
  return response.json();
}
async function courseTagFlow(teacherPage, teacherFrame, learnerPage, learnerFrame, videoId) {
  const name = 'CPU course tag <safe>', renamed = 'CPU course tag <renamed>';
  await teacherPage.locator('#videoq-course-tags summary').click();
  await teacherFrame.locator('#tags-create').click();
  await teacherFrame.locator('#tags-name').fill(name);
  await teacherFrame.locator('#tags-color').selectOption('blue');
  const created = await uiAction(teacherPage, 'tags', 'create', () => teacherFrame.locator('#tags-save').click());
  const tag = created.tags.find(tag => tag.name === name);
  assert(tag && tag.color === 'blue' && tag.editable === true);
  await teacherFrame.locator('#tags-vocabulary').getByText(name, {exact: true}).waitFor();
  assert.equal(await teacherFrame.locator('#tags-vocabulary safe').count(), 0, 'Tag text is never markup');
  await teacherFrame.getByRole('button', {name: /^(Edit material tags|教材のタグを編集)$/}).click();
  await teacherFrame.locator('#tags-fields input[type="checkbox"]').check();
  const assigned = await uiAction(teacherPage, 'tags', 'assign', () => teacherFrame.locator('#tags-save').click());
  assert.deepEqual(assigned.videos.find(video => video.videoId === videoId)?.tagIds, [tag.id]);
  await teacherFrame.locator('#tags-close').click();

  await learnerPage.locator('#videoq-course-tags summary').click();
  await learnerFrame.locator('#tags-filter option').filter({hasText: name}).waitFor({state: 'attached'});
  await learnerFrame.locator('#tags-filter').selectOption(tag.id);
  await learnerFrame.locator('#tags-materials').getByText(name, {exact: true}).waitFor();
  assert.equal(await learnerFrame.locator('#tags-create').isVisible(), false);
  const denied = await learnerFrame.evaluate(() => window.__cpuRead('tags', {
    action: 'create', operationId: crypto.randomUUID(), name: 'Denied learner tag', color: 'blue',
  }));
  assert.equal(denied.status, 403);
  await learnerFrame.getByRole('button', {name: /^(Read transcript|文字起こしを読む)$/}).click();
  await learnerFrame.locator('#tags-transcript li').first().waitFor();
  assert.match(await learnerFrame.locator('#tags-transcript').innerText(), /住所/);

  await teacherPage.locator('#videoq-course-tags summary').click();
  await teacherFrame.getByRole('button', {name: /^(Edit tag|タグを編集)$/}).click();
  await teacherFrame.locator('#tags-name').fill(renamed);
  await teacherFrame.locator('#tags-color').selectOption('green');
  const changed = await uiAction(teacherPage, 'tags', 'update', () => teacherFrame.locator('#tags-save').click());
  assert(changed.tags.some(item => item.id === tag.id && item.name === renamed && item.color === 'green'));
  await learnerFrame.locator('#tags-refresh').click();
  await learnerFrame.locator('#tags-materials').getByText(renamed, {exact: true}).waitFor();
  assert.equal(await learnerFrame.locator('#tags-materials renamed').count(), 0);
  await teacherFrame.getByRole('button', {name: /^(Edit tag|タグを編集)$/}).click();
  await teacherFrame.locator('#tags-delete').click();
  const removed = await uiAction(teacherPage, 'tags', 'delete', () => teacherFrame.locator('dialog.qa-confirm')
    .getByRole('button', {name: /^(Delete tag|タグを削除)$/}).click());
  assert.equal(removed.tags.length, 0);
  await teacherFrame.locator('#tags-close').click();
  await learnerFrame.locator('#tags-refresh').click();
  await learnerFrame.waitForFunction(() => document.querySelector('#tags-vocabulary').children.length === 0
    && document.querySelector('#tags-filter').value === '' && document.querySelector('#course-tags').getAttribute('aria-busy') === 'false');
  await learnerFrame.locator('#tags-close').click();
}
async function courseQaFlow(teacherPage, teacherFrame, learnerPage, learnerFrame, videoId) {
  const title = 'CPU learner question <safe>', editedTitle = 'CPU learner question <edited>';
  const reply = 'CPU teacher reply', editedReply = 'CPU teacher reply edited';
  await learnerPage.locator('#videoq-course-qa summary').click();
  await learnerFrame.getByRole('button', {name: /^(Ask the course|質問を投稿)$/}).click();
  await learnerFrame.locator('#qa-input-title').fill(title);
  await learnerFrame.locator('#qa-input-body').fill('A real learner asks about the public Japanese clip.');
  await learnerFrame.locator('#qa-input-lesson').selectOption(String(videoId));
  const asked = await uiAction(learnerPage, 'qa', 'ask', () => learnerFrame.locator('#qa-content form button[type="submit"]').click());
  const questionId = asked.data.id;
  assert.match(questionId, /^[a-f0-9-]{36}$/);
  await learnerFrame.getByRole('heading', {name: title, exact: true}).waitFor();
  assert.equal(await learnerFrame.locator('#qa-content safe').count(), 0);
  assert.equal(await learnerFrame.getByRole('button', {name: /^(Feature question|注目に指定)$/}).count(), 0);
  assert.equal((await learnerFrame.evaluate(questionId => window.__cpuRead('qa', {
    action: 'feature', questionId, featured: true,
  }), questionId)).status, 403);
  const own = await learnerFrame.evaluate(questionId => window.__cpuRead('qa', {action: 'get', questionId, limit: 20, offset: 0}), questionId);
  assert.equal(own.status, 200); assert.equal(own.body.data.question.videoId, videoId);

  await teacherPage.locator('#videoq-course-qa summary').click();
  await teacherFrame.getByRole('button', {name: title, exact: true}).click();
  await teacherFrame.getByRole('button', {name: /^(Reply|返信する)$/}).click();
  await teacherFrame.locator('#qa-input-body').fill(reply);
  const replied = await uiAction(teacherPage, 'qa', 'reply', () => teacherFrame.locator('#qa-content form button[type="submit"]').click());
  const replyId = replied.data.id;
  await teacherFrame.locator('#qa-content article').filter({hasText: reply}).waitFor();
  await uiAction(teacherPage, 'qa', 'vote', () => teacherFrame.getByRole('button', {name: /^(Vote|投票する) \(0\)$/}).click());
  await teacherFrame.getByRole('button', {name: /^(Remove vote|投票を取り消す) \(1\)$/}).waitFor();
  await uiAction(teacherPage, 'qa', 'vote', () => teacherFrame.getByRole('button', {name: /^(Remove vote|投票を取り消す) \(1\)$/}).click());
  await uiAction(teacherPage, 'qa', 'feature', () => teacherFrame.getByRole('button', {name: /^(Feature question|注目に指定)$/}).click());
  await teacherFrame.getByRole('button', {name: /^(Unfeature question|注目を解除)$/}).waitFor();
  await uiAction(teacherPage, 'qa', 'feature', () => teacherFrame.getByRole('button', {name: /^(Unfeature question|注目を解除)$/}).click());
  await teacherFrame.locator('#qa-content article').filter({hasText: reply}).getByRole('button', {name: /^(Edit|編集)$/}).click();
  await teacherFrame.locator('#qa-input-body').fill(editedReply);
  await uiAction(teacherPage, 'qa', 'updateReply', () => teacherFrame.locator('#qa-content form button[type="submit"]').click());
  await teacherFrame.locator('#qa-content article').filter({hasText: editedReply}).waitFor();
  assert.equal((await learnerFrame.evaluate(({questionId, replyId}) => window.__cpuRead('qa', {
    action: 'updateReply', questionId, replyId, body: 'Unauthorized learner edit',
  }), {questionId, replyId})).status, 403);
  const unchanged = await teacherFrame.evaluate(questionId => window.__cpuRead('qa', {action: 'get', questionId, limit: 20, offset: 0}), questionId);
  assert(unchanged.body.data.replies.some(item => item.id === replyId && item.body === editedReply));

  await learnerFrame.getByRole('button', {name: /^(Edit|編集)$/}).click();
  await learnerFrame.locator('#qa-input-title').fill(editedTitle);
  await uiAction(learnerPage, 'qa', 'updateQuestion', () => learnerFrame.locator('#qa-content form button[type="submit"]').click());
  await learnerFrame.getByRole('heading', {name: editedTitle, exact: true}).waitFor();
  await learnerFrame.locator('#qa-content article').filter({hasText: editedReply}).waitFor();
  const teacherReply = teacherFrame.locator('#qa-content article').filter({hasText: editedReply});
  await teacherReply.getByRole('button', {name: /^(Delete|削除)$/}).click();
  await uiAction(teacherPage, 'qa', 'deleteReply', () => teacherFrame.locator('dialog.qa-confirm')
    .getByRole('button', {name: /^(Delete|削除)$/}).click());
  await teacherFrame.waitForFunction(() => document.querySelectorAll('#qa-content article').length === 0
    && document.querySelector('#course-qa').getAttribute('aria-busy') === 'false');
  await learnerPage.locator('#videoq-course-qa summary').click();
  await teacherPage.locator('#videoq-course-qa summary').click();
  return questionId;
}
async function questionAccess(frame, questionId, expected) {
  const result = await frame.evaluate(questionId => window.__cpuRead('qa', {
    action: 'get', questionId, limit: 20, offset: 0,
  }), questionId);
  assert.equal(result.status, expected);
  if (expected === 200) assert.equal(result.body.data.question.id, questionId);
}
async function deleteOwnQuestion(page, frame) {
  await page.locator('#videoq-course-qa summary').click();
  await frame.getByRole('button', {name: /^(Delete|削除)$/}).click();
  await uiAction(page, 'qa', 'deleteQuestion', () => frame.locator('dialog.qa-confirm')
    .getByRole('button', {name: /^(Delete|削除)$/}).click());
  await frame.getByRole('button', {name: /^(Ask the course|質問を投稿)$/}).waitFor();
  const empty = await frame.evaluate(() => window.__cpuRead('qa', {action: 'list', limit: 20, offset: 0}));
  assert.equal(empty.status, 200); assert.equal(empty.body.data.total, 0);
  await page.locator('#videoq-course-qa summary').click();
}
const today = new Date().toISOString().slice(0, 10);
const period = {action: 'summary', from: today, to: today};
try {
  stage('owner-pairing');
  const admin = await context();
  const ownerLogin = await admin.request.post(VIDEOQ + '/api/auth/sign-in/email', {headers: {Origin: VIDEOQ},
    data: {email: 'onprem-lab@example.com', password: 'Local-validation-only-2026!'}});
  assert.equal(ownerLogin.status(), 200);
  const setup = await login(admin, 'admin');
  await setup.goto(MOODLE + '/local/videoq/connect.php');
  await setup.locator('#videoq-url').fill(VIDEOQ);
  await Promise.all([setup.waitForURL(url => url.origin === VIDEOQ), setup.locator('form:has(input[name="action"][value="browser"]) button').click()]);
  await setup.getByRole('button', {name: /Allow and return to Moodle|許可してMoodleへ戻る/}).click();
  await setup.waitForURL(url => url.origin === MOODLE && url.pathname === '/local/videoq/connect.php' && !url.search, {timeout: 60_000});
  assert.equal(fixture('status').connectionConfigured, true);
  await admin.close(); // No owner cookie is available to either course role.
  report.phases.push('actual-owner-browser-pairing');

  stage('teacher-enable');
  const teacher = await context();
  const teacherPage = await login(teacher, state.users.teacher.username);
  const deniedManage = await teacher.request.get(MOODLE + '/local/videoq/connect.php');
  assert(!(await deniedManage.text()).includes('id="videoq-url"'), 'Ordinary teacher cannot receive the site connection form');
  await teacherPage.goto(state.manageUrl);
  await teacherPage.locator('form:has(input[name="action"][value="enable"]) button').click();
  assert.equal(fixture('status').enabled, true);
  report.phases.push('ordinary-teacher-enable');

  stage('real-moodle-processing');
  let actual;
  for (let attempt = 0; attempt < 100; attempt++) {
    maintenance(); fixture('tick'); maintenance();
    actual = material();
    if (actual?.status === 'completed' && fixture('status').status === 'completed') break;
    assert.notEqual(actual?.status, 'error', 'Actual Moodle processing must not fail');
    await pause(10_000);
  }
  assert.equal(actual?.status, 'completed');
  assert.equal(fixture('status').status, 'completed');
  assert(actual.vectorCount > 0 && actual.asrChunks > 0, 'Real ASR checkpoints and local vector index must exist');
  assert.notEqual(actual.videoId, sentinel.videoId);
  assert.notEqual(actual.courseId, sentinel.courseId);
  assert.match(actual.transcript, /住所/);
  report.phases.push('actual-file-export-asr-indexing');

  stage('fresh-learner-native');
  const learner = await context();
  assert.equal((await learner.cookies(VIDEOQ)).length, 0);
  const learnerPage = await login(learner, state.users.learner.username);
  assert.equal((await learner.cookies(VIDEOQ)).length, 0);
  await learnerPage.goto(state.lessonUrl);
  const learnerFrame = await privateFrame(learnerPage);
  await learnerPage.locator('#videoq-native-question').waitFor();
  await learnerPage.waitForFunction(() => !document.querySelector('#videoq-native-controls').disabled);
  assert.equal(await learnerPage.evaluate(() => window.__cpuBridge.videoId), actual.videoId);
  assert.equal(await learnerPage.locator('#videoq-course-reports').isVisible(), false);
  assert.equal((await learnerFrame.evaluate(period => window.__cpuRead('reports', period), period)).status, 403);
  assert.equal((await materials(learnerPage, 'transcript', sentinel.videoId)).ok, false);
  assert.equal((await materials(learnerPage)).ok, true);
  report.phases.push('fresh-learner-ready-and-owner-sentinel-denied');

  stage('real-native-question');
  const question = '動画では、インターネットで「敵対的環境コース」を検索すると何の住所が出てくると述べていますか？';
  const streamResponse = learnerPage.waitForResponse(response => new URL(response.url()).pathname === '/api/lti/messages/stream');
  await learnerPage.locator('#videoq-native-question').fill(question);
  await learnerPage.locator('#videoq-native-send').click();
  const response = await streamResponse;
  assert.equal(response.status(), 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  assert(events.some(event => event.type === 'done'));
  assert(!events.some(event => event.type === 'error'));
  const text = events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
  assert.match(text, /住所/); assert.match(text, /企業|会社/);
  const sources = events.filter(event => event.type === 'source').map(event => event.source);
  assert(sources.length > 0 && sources.every(source => source.video_id === actual.videoId));
  await learnerPage.locator('#videoq-native-messages .answer .citation').first().waitFor();
  const seconds = sources[0].start_time.replace(',', '.').split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  // Moodle's Video.js may turn the original id into a wrapper div.
  const media = learnerPage.locator('video#videoq-player, #videoq-player video').first();
  await learnerPage.waitForFunction(() => document.querySelector('video#videoq-player, #videoq-player video')?.readyState >= 2);
  const mediaUrl = await media.evaluate(video => video.currentSrc);
  assert.equal(new URL(mediaUrl).origin, MOODLE);
  const range = await learner.request.get(mediaUrl, {headers: {Range: 'bytes=0-15'}});
  assert.equal(range.status(), 206); assert.equal((await range.body()).length, 16);
  assert.equal(range.headers()['x-moodle-media-offload'], '1');
  await media.evaluate((video, seconds) => {video.muted = true; video.currentTime = Math.min(video.duration - 0.25, seconds + 3);}, seconds);
  await learnerPage.locator('#videoq-native-messages .answer .citation').first().click();
  await learnerPage.waitForFunction(seconds => Math.abs(document.querySelector('video#videoq-player, #videoq-player video').currentTime - seconds) < 0.75, seconds);
  await media.evaluate(async video => {await video.play();});
  await learnerPage.waitForFunction(seconds => document.querySelector('video#videoq-player, #videoq-player video').currentTime > seconds + 0.1, seconds);
  assert.equal(await media.evaluate(video => video.error?.code ?? null), null);
  const feedback = learnerPage.waitForResponse(response => new URL(response.url()).pathname === '/api/lti/feedback');
  await learnerPage.locator('#videoq-native-messages .answer [data-feedback="good"]').last().click();
  assert.equal((await feedback).status(), 200);
  report.phases.push('real-streamed-answer-citation-seek-decode-feedback');

  stage('personal-history');
  await learnerPage.locator('#videoq-personal-history summary').click();
  await learnerFrame.locator('#personal-history-content article').first().waitFor();
  await learnerFrame.getByRole('button', {name: /^(Read|読む)$/}).first().click();
  await learnerFrame.locator('.personal-turn').first().waitFor();
  assert.match(await learnerFrame.locator('#personal-history-content').innerText(), /住所/);
  await learnerFrame.getByRole('button', {name: /Continue this conversation|この会話を続ける/}).click();
  await learnerPage.locator('#videoq-native-messages .answer .citation').first().waitFor();
  report.phases.push('nonempty-personal-history-resume');

  await teacherPage.goto(state.lessonUrl);
  const teacherFrame = await privateFrame(teacherPage);
  stage('course-tags');
  await courseTagFlow(teacherPage, teacherFrame, learnerPage, learnerFrame, actual.videoId);
  report.phases.push('actual-course-tags-crud-assignment-learner-denial-and-transcript');
  stage('human-qa');
  const questionId = await courseQaFlow(teacherPage, teacherFrame, learnerPage, learnerFrame, actual.videoId);
  report.phases.push('actual-human-qa-post-reply-edit-votes-moderation-and-cross-author-denial');

  stage('positive-reports');
  period.to = new Date().toISOString().slice(0, 10);
  await teacherPage.locator('#videoq-course-reports summary').click();
  await teacherFrame.locator('#reports-content tbody tr').first().waitFor();
  const summary = await teacherFrame.evaluate(period => window.__cpuRead('reports', period), period);
  assert.equal(summary.status, 200); assert.equal(summary.body.period.timezone, 'UTC');
  assert.deepEqual(summary.body.totals, {questions: 1, good: 1, bad: 0, none: 0});
  const download = teacherPage.waitForEvent('download');
  await teacherFrame.locator('#reports-export').click();
  const csv = await download;
  const csvPath = await csv.path();
  const csvText = readFileSync(csvPath, 'utf8');
  assert(csvText.startsWith('date,questions,good,bad,unrated\n'));
  assert(csvText.split('\n').length > 2);
  fixture('deny-reports');
  const revoked = teacherPage.waitForResponse(response => new URL(response.url()).pathname === '/api/lti/reports' && response.status() === 403);
  await teacherFrame.locator('#reports-form button[type="submit"]').click();
  await revoked;
  await teacherFrame.waitForFunction(() => document.querySelector('#reports-content').children.length === 0);
  fixture('allow-reports');
  assert.equal((await materials(teacherPage)).payload.permissions.viewReports, true);
  assert.equal((await teacherFrame.evaluate(period => window.__cpuRead('reports', period), period)).status, 200);
  report.phases.push('positive-utc-report-csv-and-same-session-capability-revocation');

  stage('same-session-source-enrolment');
  fixture('hide'); assert.equal((await materials(learnerPage)).ok, false);
  await questionAccess(learnerFrame, questionId, 403);
  assert.notEqual((await learner.request.get(mediaUrl, {headers: {Range: 'bytes=0-15'}})).status(), 206);
  assert.equal((await materials(teacherPage)).ok, true);
  fixture('show'); assert.equal((await materials(learnerPage)).ok, true);
  await questionAccess(learnerFrame, questionId, 200);
  fixture('suspend'); assert.equal((await materials(learnerPage)).ok, false);
  await questionAccess(learnerFrame, questionId, 403);
  assert.notEqual((await learner.request.get(mediaUrl, {headers: {Range: 'bytes=0-15'}})).status(), 206);
  fixture('resume'); assert.equal((await materials(learnerPage)).ok, true);
  await questionAccess(learnerFrame, questionId, 200);
  await deleteOwnQuestion(learnerPage, learnerFrame);
  report.phases.push('actual-human-qa-current-source-enrolment-and-own-deletion');
  assert.equal(await learnerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await learnerPage.screenshot({path: join(dirname(resultPath), 'moodle-native-mobile.png'), fullPage: true});
  report.phases.push('same-session-hidden-source-enrolment-current-authority');
  Object.assign(report, {status: 'passed', stage: 'complete', transcript: actual.transcript,
    managedVideoId: actual.videoId, standaloneSentinelDenied: true, asrChunks: actual.asrChunks,
    vectorCount: actual.vectorCount, embeddingTable, answer: text, sourceVideoIds: sources.map(source => source.video_id),
    requestedCitationSeconds: seconds, reports: summary.body.totals,
    limits: ['Public File + local CPU fixture only; cloud YouTube/provider, independent-site restore, restricted worker and wider feature inventory remain separate gates.']});
  writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  writeFileSync(join(dirname(resultPath), 'moodle-stage.json'), JSON.stringify({
    stage: report.stage, completed: report.phases, failure: browserFailure(error, import.meta.url),
  }) + '\n');
  throw error;
} finally {
  await browser.close();
}
