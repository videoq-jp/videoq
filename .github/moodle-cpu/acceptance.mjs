// Actual browser + Moodle core + VideoQ + CPU inference. No HTTP/AI responses
// are substituted. All identities/media belong to the disposable parent lab.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {AcceptanceCommandError, browserFailure, clickActionabilityEvidence, mediaRangeEvidence, tagUiEvidence} from './browser-evidence.mjs';
import {fileURLToPath} from 'node:url';
import {corePrivacy} from './privacy.mjs';
import {installNativeReader, waitLearningResponse} from './native-browser.mjs';

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
function k(args, input, operation = 'cluster-read', maxBuffer = 2_000_000) {
  try {
    return execFileSync('kubectl', [...prefix, ...args], {encoding: 'utf8', input, timeout: 120_000, maxBuffer});
  } catch (error) {
    throw new AcceptanceCommandError(error, operation);
  }
}
function requireOwner() {
  const marker = JSON.parse(k(['get', 'configmap', 'videoq-moodle-cpu-owner', '-o', 'json']));
  assert.equal(marker.data.owner, owner);
  assert.equal(marker.metadata.labels['jp.videoq.moodle-cpu-owner'], owner);
}
function fixture(action, input) {
  assert(['status', 'tick', 'hide', 'show', 'suspend', 'resume', 'deny-reports', 'allow-reports',
    'privacy-setup', 'privacy-status', 'privacy-task', 'privacy-export-evidence', 'privacy-reset'].includes(action));
  requireOwner();
  return JSON.parse(k(['exec', ...(input === undefined ? [] : ['-i']), 'deployment/moodle', '--', 'php', '/acceptance/fixture.php', action],
    input === undefined ? undefined : JSON.stringify(input), 'moodle-' + action));
}
function maintenance() {
  requireOwner();
  // This CLI operates only on the parent's isolated synthetic database. It runs
  // inside the CA-mounted actual API container, with the real runtime config.
  const preload = 'data:text/javascript;base64,' + readFileSync(new URL('./maintenance-observer.mjs', import.meta.url)).toString('base64');
  k(['exec', 'deployment/videoq-api', '--', 'env', 'VIDEOQ_MOODLE_CPU_OBSERVER=1',
    'node', '--import', preload, 'dist/node.mjs', 'maintenance'], undefined, 'backend-maintenance');
}
function material() {
  requireOwner();
  // Baseline lifecycle restored the application into this separate DB. This is
  // read-only evidence; no status, transcript, vector or job row is fabricated.
  const sql = `SELECT row_to_json(t) FROM (SELECT v.id::int AS "videoId",r.course_id::int AS "courseId",v.status,
    v.transcript,(SELECT count(*)::int FROM ${embeddingTable} e WHERE e.video_id=v.id) AS "vectorCount",
    (SELECT min(e.langchain_id::text) FROM ${embeddingTable} e WHERE e.video_id=v.id) AS "vectorHead",
    (SELECT count(*)::int FROM video_transcription_chunks c JOIN video_transcription_runs x ON x.run_id=c.run_id
      WHERE x.video_id=v.id AND c.segments IS NOT NULL) AS "asrChunks"
    FROM lms_resources r JOIN lms_installations i ON i.id=r.installation_id JOIN videos v ON v.id=r.video_id
    WHERE i.issuer='${MOODLE}' AND r.context_id='${state.courseId}' AND r.kind='video'
      AND r.enabled=true AND v.managed_by_lms=true) t;`;
  const raw = k(['exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-d', 'restored', '-At', '-v', 'ON_ERROR_STOP=1'], sql, 'material-evidence').trim();
  if (!raw) return null;
  const lines = raw.split('\n');
  assert.equal(lines.length, 1, 'Exactly the owned Moodle File must be managed');
  return JSON.parse(lines[0]);
}
function standaloneIndexState() {
  requireOwner();
  const sql = `SELECT row_to_json(t) FROM (SELECT v.status,md5(COALESCE(v.transcript,'')) AS transcript,
    (SELECT md5(string_agg(e.langchain_id::text,',' ORDER BY e.langchain_id)) FROM scene_embeddings e WHERE e.video_id=v.id) AS hosted,
    (SELECT md5(string_agg(e.langchain_id::text,',' ORDER BY e.langchain_id)) FROM scene_embeddings_768 e WHERE e.video_id=v.id) AS local
    FROM videos v WHERE v.id=${sentinel.videoId}) t;`;
  return JSON.parse(k(['exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-d', 'restored', '-At', '-v', 'ON_ERROR_STOP=1'], sql, 'standalone-index-evidence'));
}
function conversationDigest(conversationId) {
  assert.match(conversationId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  requireOwner();
  const sql = `SELECT md5(thread_id) FROM chat_conversations WHERE conversation_id='${conversationId}';`;
  const digest = k(['exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-d', 'restored', '-At', '-v', 'ON_ERROR_STOP=1'], sql, 'conversation-evidence').trim();
  assert.match(digest, /^[a-f0-9]{32}$/);
  return digest;
}
function conversationStorage(digest) {
  assert.match(digest, /^[a-f0-9]{32}$/);
  requireOwner();
  const tables = {conversations: 'public.chat_conversations', turns: 'public.chat_conversation_turns',
    scopes: 'public.lti_conversation_scopes', checkpoints: 'chat_memory.checkpoints',
    blobs: 'chat_memory.checkpoint_blobs', writes: 'chat_memory.checkpoint_writes'};
  const fields = Object.entries(tables).map(([key, table]) =>
    `(SELECT count(*)::int FROM ${table} WHERE md5(thread_id)='${digest}') AS ${key}`);
  const sql = 'SELECT row_to_json(t) FROM (SELECT ' + fields.join(',') + ') t;';
  return JSON.parse(k(['exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-d', 'restored', '-At', '-v', 'ON_ERROR_STOP=1'], sql, 'conversation-evidence'));
}
function conversationMemoryRecords(digest, conversationId) {
  assert.match(digest, /^[a-f0-9]{32}$/);
  assert.match(conversationId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  requireOwner();
  // Independent read-only snapshots from the actual official model tables.
  // The private JSON is compared to the real core archive, never logged/uploaded.
  const fields = {
    checkpoints: "'checkpointId',k.checkpoint_id,'parentCheckpointId',k.parent_checkpoint_id,'checkpoint',k.checkpoint",
    checkpoint_blobs: "'channel',k.channel,'version',k.version,'type',k.type,'encoding','base64','data',encode(k.blob,'base64')",
    checkpoint_writes: "'checkpointId',k.checkpoint_id,'index',k.idx,'channel',k.channel,'type',k.type,'encoding','base64','data',encode(k.blob,'base64')",
  };
  const columns = Object.entries(fields).map(([table, data]) => `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'conversationId','${conversationId}','namespace',k.checkpoint_ns,${data})), '[]'::jsonb)
    FROM chat_memory.${table} k WHERE md5(k.thread_id)='${digest}') AS ${table}`);
  const sql = 'SELECT row_to_json(t) FROM (SELECT ' + columns.join(',') + ') t;';
  return JSON.parse(k(['exec', '-i', 'deployment/postgres', '--', 'psql', '-U', 'postgres', '-d', 'restored', '-At', '-v', 'ON_ERROR_STOP=1'],
    sql, 'privacy-memory-evidence', 64 * 1024 * 1024));
}
function verifyPrivacyArchive(path, expected) {
  try {
    return JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./privacy-archive.py', import.meta.url)), path], {
      input: JSON.stringify(expected), encoding: 'utf8', timeout: 30_000, maxBuffer: 4096,
    }));
  } catch (error) {
    throw new AcceptanceCommandError(error, 'privacy-archive-evidence');
  }
}

const browser = await chromium.launch({headless: true});
const parentNavigation = new WeakMap();
const nativePages = new Set();
async function context() {
  // The browser context is restricted to three known loopback fixture origins.
  // PHP and API use the actual trusted CA for all server-to-server requests;
  // the browser's local self-signed exception is isolated to this test context.
  const ctx = await browser.newContext({ignoreHTTPSErrors: true, locale: 'en-US',
    viewport: {width: 390, height: 844}, serviceWorkers: 'block', acceptDownloads: true});
  ctx.on('page', page => {
    const navigation = {started: 0, finished: 0, failed: 0, pending: new Set(), kind: 'other',
      native: false, headers: new Set(), gatewayRequests: 0, outsideRequests: 0, authorizationHeaders: 0, unreadableHeaders: 0};
    parentNavigation.set(page, navigation);
    const isParent = request => {
      try {return request.isNavigationRequest() && request.frame() === page.mainFrame();} catch {return false;}
    };
    page.on('request', request => {
      const url = new URL(request.url());
      if (isParent(request)) {
        navigation.started++; navigation.pending.add(request);
        navigation.kind = url.pathname === '/login/index.php' ? 'login' : url.pathname === '/local/videoq/view.php' ? 'lesson' : 'other';
        if (url.origin === MOODLE && url.pathname === '/local/videoq/view.php') {
          navigation.native = true; nativePages.add(page);
        }
      }
      // Other origins are blocked by the fixture route above. Inspect the
      // actual Moodle/VideoQ realms without treating Moodle's optional CDN
      // assets as VideoQ learning transport.
      if (navigation.native && allowedOrigins.has(url.origin)) {
        if (url.origin !== MOODLE) navigation.outsideRequests++;
        if (url.origin === MOODLE && url.pathname === '/lib/ajax/service.php') navigation.gatewayRequests++;
        const task = request.allHeaders().then(headers => {if (headers.authorization) navigation.authorizationHeaders++;},
          () => {navigation.unreadableHeaders++;}).finally(() => navigation.headers.delete(task));
        navigation.headers.add(task);
      }
    });
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      const url = new URL(frame.url());
      navigation.native = url.origin === MOODLE && url.pathname === '/local/videoq/view.php';
    });
    for (const [event, field] of [['requestfinished', 'finished'], ['requestfailed', 'failed']])
      page.on(event, request => {if (navigation.pending.delete(request)) navigation[field]++;});
  });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    return allowedOrigins.has(url.origin) || ['data:', 'about:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient');
  });
  await installNativeReader(ctx);
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
async function nativeBrowserEvidence() {
  let gatewayRequests = 0, outsideRequests = 0, authorizationHeaders = 0, unreadableHeaders = 0;
  for (const page of nativePages) {
    const nav = parentNavigation.get(page);
    await Promise.all([...nav.headers]);
    gatewayRequests += nav.gatewayRequests; outsideRequests += nav.outsideRequests;
    authorizationHeaders += nav.authorizationHeaders; unreadableHeaders += nav.unreadableHeaders;
    if (!page.isClosed() && new URL(page.url()).pathname === '/local/videoq/view.php')
      assert.equal(await page.locator('iframe').count(), 0, 'Native learning never creates a hidden authentication frame');
  }
  const evidence = {pages: nativePages.size, gatewayRequests, outsideRequests, authorizationHeaders, unreadableHeaders};
  assert(evidence.pages >= 2 && evidence.gatewayRequests > 0);
  assert.equal(outsideRequests, 0, 'Native browser learning never calls VideoQ or its storage directly');
  assert.equal(authorizationHeaders, 0, 'Browser never carries VideoQ assertions or bearer sessions');
  assert.equal(unreadableHeaders, 0, 'Every native browser request was inspected');
  return evidence;
}
async function nativePage(page) {
  await page.locator('.local-videoq-workspace[data-videoq-native]').waitFor();
  assert.equal(await page.locator('[data-rel="debugging"]').count(), 0,
    'Native Moodle page renders without developer debugging output');
  assert.equal((await page.locator('body').innerText()).includes('Cannot modify header information'), false,
    'Native Moodle page sends its headers before rendering');
  assert.equal(await page.locator('iframe').count(), 0, 'File learning has no presentation or authentication iframe');
  assert.equal(await page.locator('[data-videoq-origin]').count(), 0, 'No browser-side VideoQ transport configuration');
  const metadata = await page.evaluate(() => window.__cpuRead('materials', {}));
  report.nativeBootstrap = {status: metadata.status, protocol: metadata.body.nativeProtocol === 1};
  assert.equal(metadata.status, 200, 'Real Moodle PHP assertions authorize the native learning API');
  assert.equal(metadata.body.nativeProtocol, 1);
  return page;
}
async function materials(page, action = 'list', targetVideoId) {
  const value = await page.evaluate(({action, targetVideoId}) => window.__cpuRead(action === 'list' ? 'materials' : 'transcript',
    action === 'list' ? {} : {videoId: targetVideoId, cursor: 0}), {action, targetVideoId});
  return value.status === 200 ? {ok: true, payload: value.body} : {ok: false};
}
async function uiAction(page, feature, action, click, status = 200) {
  const [response] = await Promise.all([waitLearningResponse(page, feature, action), click()]);
  assert.equal(response.status, status, 'Actual Moodle-native UI operation succeeds');
  return response.body;
}
async function nativeTranscriptFlow(page, videoId) {
  await page.locator('#videoq-course-materials summary').click();
  await page.locator('#videoq-material-cues li').first().waitFor();
  assert.equal(await page.locator('#videoq-material-video').inputValue(), String(videoId));
  assert.match(await page.locator('#videoq-material-cues').innerText(), /住所/);
  const cue = page.locator('#videoq-material-cues button').first();
  const seconds = (await cue.innerText()).replace(',', '.').split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  assert(Number.isFinite(seconds) && seconds >= 0);
  await page.locator('video#videoq-player, #videoq-player video').first().evaluate((video, seconds) => {
    video.pause(); video.currentTime = Math.min(video.duration - 0.25, seconds + 3);
  }, seconds);
  await cue.click();
  await page.waitForFunction(seconds => Math.abs(document.querySelector('video#videoq-player, #videoq-player video').currentTime - seconds) < 0.75, seconds);
  await page.locator('#videoq-material-refresh').click();
  await page.waitForFunction(() => document.querySelector('#videoq-course-materials').getAttribute('aria-busy') === 'false'
    && document.querySelectorAll('#videoq-material-cues li').length > 0);
  assert.match(await page.locator('#videoq-material-cues').innerText(), /住所/);
  await page.locator('#videoq-course-materials summary').click();
}
async function waitForManagedIndex(frame, transcript, previousHead, empty = false) {
  let current;
  for (let attempt = 0; attempt < 100; attempt++) {
    maintenance(); fixture('tick'); maintenance();
    current = material();
    assert.notEqual(current?.status, 'error', 'Actual teacher indexing must not fail');
    if (current?.status === 'completed' && current.transcript === transcript
        && (empty ? current.vectorCount === 0 : current.vectorCount > 0 && current.vectorHead !== previousHead)
        && fixture('status').status === 'completed') {
      const receipt = await frame.evaluate(videoId => window.__cpuRead('management', {action: 'get', videoId}), current.videoId);
      assert.equal(receipt.status, 200);
      if (receipt.body.material.jobState === 'completed' && receipt.body.material.transcript === transcript) return current;
    }
    await pause(5_000);
  }
  throw new Error('Actual teacher index did not reach its required transcript/vector state');
}
async function teacherManagementFlow(page, frame, learnerUi, actual, verifySourceMedia) {
  const standalone = standaloneIndexState();
  assert.equal(standalone.status, 'completed');
  assert.match(standalone[embeddingTable === 'scene_embeddings' ? 'hosted' : 'local'], /^[a-f0-9]{32}$/);
  await page.locator('#videoq-material-management summary').click();
  await frame.waitForFunction(() => document.querySelector('#videoq-management-transcript').readOnly === false);
  assert.equal(await frame.locator('#videoq-management-transcript').inputValue(), actual.transcript);
  const denied = await learnerUi.evaluate(videoId => window.__cpuRead('management', {action: 'get', videoId}), actual.videoId);
  assert.equal(denied.status, 403);
  const description = 'Teacher AI description <safe>';
  await frame.locator('#videoq-management-description').fill(description);
  const edited = await uiAction(page, 'management', 'update', () => frame.locator('#videoq-management-save').click());
  assert.equal(edited.material.description, description);
  assert.equal(edited.material.transcript, actual.transcript);
  assert.equal(edited.material.status, 'completed');
  assert.equal((await learnerUi.evaluate(({videoId, revision}) => window.__cpuRead('management', {
    action: 'update', videoId, revision, operationId: crypto.randomUUID(), fields: {description: 'Denied learner edit'},
  }), {videoId: actual.videoId, revision: edited.material.revision})).status, 403);
  const saved = await frame.evaluate(videoId => window.__cpuRead('management', {action: 'get', videoId}), actual.videoId);
  assert.equal(saved.status, 200); assert.equal(saved.body.material.description, description);

  await frame.locator('#videoq-management-reindex').click();
  const reindex = await uiAction(page, 'management', 'reindex', () => frame.locator('dialog.local-videoq-confirm')
    .getByRole('button', {name: /^(Continue|続ける)$/}).click(), 202);
  assert.equal(reindex.material.status, 'indexing');
  const rebuilt = await waitForManagedIndex(frame, actual.transcript, actual.vectorHead);
  assert.equal(rebuilt.asrChunks, actual.asrChunks, 'Reindex reuses the real ASR checkpoint');
  assert.deepEqual(standaloneIndexState(), standalone, 'Reindex preserves the standalone material');
  await frame.locator('#videoq-management-refresh').click();
  await frame.waitForFunction(() => document.querySelector('#videoq-management-transcript').readOnly === false);

  // This is an actual confirmed teacher edit, not fixture data insertion. The
  // source file and original ASR are retained, and that same ASR is restored next.
  await frame.locator('#videoq-management-transcript').fill('');
  await frame.locator('#videoq-management-save').click();
  const cleared = await uiAction(page, 'management', 'update', () => frame.locator('dialog.local-videoq-confirm')
    .getByRole('button', {name: /^(Continue|続ける)$/}).click(), 202);
  assert.equal(cleared.material.transcript, '');
  const empty = await waitForManagedIndex(frame, '', rebuilt.vectorHead, true);
  assert.equal(empty.asrChunks, actual.asrChunks);
  assert.deepEqual(standaloneIndexState(), standalone, 'Clear only removes the managed material index');
  await verifySourceMedia();
  await frame.locator('#videoq-management-refresh').click();
  await frame.waitForFunction(() => document.querySelector('#videoq-management-transcript').readOnly === false
    && document.querySelector('#videoq-management-transcript').value === '');
  await frame.locator('#videoq-management-transcript').fill(actual.transcript);
  const restored = await uiAction(page, 'management', 'update', () => frame.locator('#videoq-management-save').click(), 202);
  assert.equal(restored.material.transcript, actual.transcript);
  const indexed = await waitForManagedIndex(frame, actual.transcript, rebuilt.vectorHead);
  assert.equal(indexed.asrChunks, actual.asrChunks);
  assert.deepEqual(standaloneIndexState(), standalone, 'Restore preserves the standalone material');
  await frame.locator('#videoq-management-refresh').click();
  await frame.waitForFunction(() => document.querySelector('#videoq-management-transcript').readOnly === false);
  assert.equal(await frame.locator('#videoq-management-description').inputValue(), description);
  await frame.locator('#videoq-management-close').click();
}
async function courseTagFlow(teacherPage, teacherUi, learnerPage, learnerUi, videoId) {
  try {await courseTagActions(teacherPage, teacherUi, learnerPage, learnerUi, videoId);}
  catch (error) {
    async function snapshot(page) {
      const row = await page.evaluate(() => {
        const panel = document.querySelector('#videoq-course-tags'), button = document.querySelector('#videoq-tags-create');
        if (!panel || !button) return {missingNativeControl: true};
        const r = button.getBoundingClientRect(), style = getComputedStyle(button), x = r.x + r.width / 2, y = r.y + r.height / 2,
          hit = document.elementFromPoint(x, y);
        return {moodleNative: !!document.querySelector('.local-videoq-workspace[data-videoq-native]'),
          iframeCount: document.querySelectorAll('iframe').length, panelHidden: panel.hidden, panelOpen: panel.open,
          buttonHidden: button.hidden, buttonDisabled: button.disabled,
          buttonVisible: r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          buttonWidth: Math.round(r.width), buttonHeight: Math.round(r.height), buttonHit: hit === button || button.contains(hit),
          buttonInViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
          buttonPointerEventsNone: style.pointerEvents === 'none', buttonTop: Math.round(r.top), buttonBottom: Math.round(r.bottom),
          busy: panel.getAttribute('aria-busy') === 'true', panelClientHeight: panel.clientHeight,
          panelScrollHeight: panel.scrollHeight, panelScrollTop: Math.round(panel.scrollTop),
          viewportHeight: innerHeight, viewportWidth: innerWidth, openDialogs: document.querySelectorAll('dialog[open]').length,
          parentDocumentState: document.readyState};
      });
      const nav = parentNavigation.get(page);
      if (nav) Object.assign(row, {parentDocumentsStarted: nav.started, parentDocumentsFinished: nav.finished,
        parentDocumentsFailed: nav.failed, parentDocumentsPending: nav.pending.size, parentDocumentKind: nav.kind});
      const catalog = await page.evaluate(() => new Promise(resolve => {
        const timer = setTimeout(() => resolve({timedOut: true}), 15_000);
        window.__cpuRead('tags', {action: 'list'}).then(value => {clearTimeout(timer);
          resolve({status: value.status, canManage: value.body?.canManage,
            tags: Array.isArray(value.body?.tags) ? value.body.tags.length : undefined,
            videos: Array.isArray(value.body?.videos) ? value.body.videos.length : undefined});
        }).catch(() => {clearTimeout(timer); resolve({requestFailed: true});});
      }));
      return {...row, catalog};
    }
    const values = await Promise.allSettled([snapshot(teacherPage), snapshot(learnerPage)]);
    report.tagsUi = tagUiEvidence(Object.fromEntries(['teacher', 'learner'].flatMap((role, index) =>
      values[index].status === 'fulfilled' ? [[role, values[index].value]] : [])));
    throw error;
  }
}
async function courseTagActions(teacherPage, teacherUi, learnerPage, learnerUi, videoId) {
  const name = 'CPU course tag <safe>', renamed = 'CPU course tag <renamed>';
  await teacherPage.locator('#videoq-course-tags summary').click();
  // A mobile user scrolls to the native Moodle control before operating it.
  // Keep real click/actionability checks and their deadline.
  await teacherPage.locator('#videoq-tags-create').scrollIntoViewIfNeeded();
  await teacherUi.locator('#videoq-tags-create').click();
  await teacherUi.locator('#videoq-tags-name').fill(name);
  await teacherUi.locator('#videoq-tags-color').selectOption('blue');
  const created = await uiAction(teacherPage, 'tags', 'create', () => teacherUi.locator('#videoq-tags-save').click());
  const tag = created.tags.find(tag => tag.name === name);
  assert(tag && tag.color === 'blue' && tag.editable === true);
  await teacherUi.locator('#videoq-tags-vocabulary').getByText(name, {exact: true}).waitFor();
  assert.equal(await teacherUi.locator('#videoq-tags-vocabulary safe').count(), 0, 'Tag text is never markup');
  await teacherUi.getByRole('button', {name: /^(Edit material tags|教材のタグを編集)$/}).click();
  await teacherUi.locator('#videoq-tags-fields input[type="checkbox"]').check();
  const assigned = await uiAction(teacherPage, 'tags', 'assign', () => teacherUi.locator('#videoq-tags-save').click());
  assert.deepEqual(assigned.videos.find(video => video.videoId === videoId)?.tagIds, [tag.id]);
  await teacherUi.locator('#videoq-tags-close').click();

  await learnerPage.locator('#videoq-course-tags summary').click();
  await learnerUi.locator('#videoq-tags-filter option').filter({hasText: name}).waitFor({state: 'attached'});
  await learnerUi.locator('#videoq-tags-filter').selectOption(tag.id);
  await learnerUi.locator('#videoq-tags-materials').getByText(name, {exact: true}).waitFor();
  assert.equal(await learnerUi.locator('#videoq-tags-create').isVisible(), false);
  const denied = await learnerUi.evaluate(() => window.__cpuRead('tags', {
    action: 'create', operationId: crypto.randomUUID(), name: 'Denied learner tag', color: 'blue',
  }));
  assert.equal(denied.status, 403);
  await learnerUi.getByRole('button', {name: /^(Read transcript|文字起こしを読む)$/}).click();
  await learnerUi.locator('#videoq-tags-transcript li').first().waitFor();
  assert.match(await learnerUi.locator('#videoq-tags-transcript').innerText(), /住所/);

  await teacherPage.locator('#videoq-course-tags summary').click();
  await teacherUi.getByRole('button', {name: /^(Edit tag|タグを編集)$/}).click();
  await teacherUi.locator('#videoq-tags-name').fill(renamed);
  await teacherUi.locator('#videoq-tags-color').selectOption('green');
  const changed = await uiAction(teacherPage, 'tags', 'update', () => teacherUi.locator('#videoq-tags-save').click());
  assert(changed.tags.some(item => item.id === tag.id && item.name === renamed && item.color === 'green'));
  await learnerUi.locator('#videoq-tags-refresh').click();
  await learnerUi.locator('#videoq-tags-materials').getByText(renamed, {exact: true}).waitFor();
  assert.equal(await learnerUi.locator('#videoq-tags-materials renamed').count(), 0);
  await teacherUi.getByRole('button', {name: /^(Edit tag|タグを編集)$/}).click();
  await teacherUi.locator('#videoq-tags-delete').click();
  const removed = await uiAction(teacherPage, 'tags', 'delete', () => teacherUi.locator('dialog.local-videoq-confirm')
    .getByRole('button', {name: /^(Delete tag|タグを削除)$/}).click());
  assert.equal(removed.tags.length, 0);
  await teacherUi.locator('#videoq-tags-close').click();
  await learnerUi.locator('#videoq-tags-refresh').click();
  await learnerUi.waitForFunction(() => document.querySelector('#videoq-tags-vocabulary').children.length === 0
    && document.querySelector('#videoq-tags-filter').value === '' && document.querySelector('#videoq-course-tags').getAttribute('aria-busy') === 'false');
  await learnerUi.locator('#videoq-tags-close').click();
}
async function courseQaFlow(teacherPage, teacherUi, learnerPage, learnerUi, videoId) {
  const title = 'CPU learner question <safe>', editedTitle = 'CPU learner question <edited>';
  const reply = 'CPU teacher reply', editedReply = 'CPU teacher reply edited';
  await learnerPage.locator('#videoq-course-qa summary').click();
  await learnerUi.getByRole('button', {name: /^(Ask the course|質問を投稿)$/}).click();
  await learnerUi.locator('#videoq-qa-input-title').fill(title);
  await learnerUi.locator('#videoq-qa-input-body').fill('A real learner asks about the public Japanese clip.');
  await learnerUi.locator('#videoq-qa-input-lesson').selectOption(String(videoId));
  const asked = await uiAction(learnerPage, 'qa', 'ask', () => learnerUi.locator('#videoq-qa-content form button[type="submit"]').click());
  const questionId = asked.data.id;
  assert.match(questionId, /^[a-f0-9-]{36}$/);
  await learnerUi.getByRole('heading', {name: title, exact: true}).waitFor();
  assert.equal(await learnerUi.locator('#videoq-qa-content safe').count(), 0);
  assert.equal(await learnerUi.getByRole('button', {name: /^(Feature question|注目に指定)$/}).count(), 0);
  assert.equal((await learnerUi.evaluate(questionId => window.__cpuRead('qa', {
    action: 'feature', questionId, featured: true,
  }), questionId)).status, 403);
  const own = await learnerUi.evaluate(questionId => window.__cpuRead('qa', {action: 'get', questionId, limit: 20, offset: 0}), questionId);
  assert.equal(own.status, 200); assert.equal(own.body.data.question.videoId, videoId);

  await teacherPage.locator('#videoq-course-qa summary').click();
  await teacherUi.getByRole('button', {name: title, exact: true}).click();
  await teacherUi.getByRole('button', {name: /^(Reply|返信する)$/}).click();
  await teacherUi.locator('#videoq-qa-input-body').fill(reply);
  const replied = await uiAction(teacherPage, 'qa', 'reply', () => teacherUi.locator('#videoq-qa-content form button[type="submit"]').click());
  const replyId = replied.data.id;
  await teacherUi.locator('#videoq-qa-content article').filter({hasText: reply}).waitFor();
  await uiAction(teacherPage, 'qa', 'vote', () => teacherUi.getByRole('button', {name: /^(Vote|投票する) \(0\)$/}).click());
  await teacherUi.getByRole('button', {name: /^(Remove vote|投票を取り消す) \(1\)$/}).waitFor();
  await uiAction(teacherPage, 'qa', 'vote', () => teacherUi.getByRole('button', {name: /^(Remove vote|投票を取り消す) \(1\)$/}).click());
  await uiAction(teacherPage, 'qa', 'feature', () => teacherUi.getByRole('button', {name: /^(Feature question|注目に指定)$/}).click());
  await teacherUi.getByRole('button', {name: /^(Unfeature question|注目を解除)$/}).waitFor();
  await uiAction(teacherPage, 'qa', 'feature', () => teacherUi.getByRole('button', {name: /^(Unfeature question|注目を解除)$/}).click());
  await teacherUi.locator('#videoq-qa-content article').filter({hasText: reply}).getByRole('button', {name: /^(Edit|編集)$/}).click();
  await teacherUi.locator('#videoq-qa-input-body').fill(editedReply);
  await uiAction(teacherPage, 'qa', 'updateReply', () => teacherUi.locator('#videoq-qa-content form button[type="submit"]').click());
  await teacherUi.locator('#videoq-qa-content article').filter({hasText: editedReply}).waitFor();
  assert.equal((await learnerUi.evaluate(({questionId, replyId}) => window.__cpuRead('qa', {
    action: 'updateReply', questionId, replyId, body: 'Unauthorized learner edit',
  }), {questionId, replyId})).status, 403);
  const unchanged = await teacherUi.evaluate(questionId => window.__cpuRead('qa', {action: 'get', questionId, limit: 20, offset: 0}), questionId);
  assert(unchanged.body.data.replies.some(item => item.id === replyId && item.body === editedReply));

  await learnerUi.getByRole('button', {name: /^(Edit|編集)$/}).click();
  await learnerUi.locator('#videoq-qa-input-title').fill(editedTitle);
  await uiAction(learnerPage, 'qa', 'updateQuestion', () => learnerUi.locator('#videoq-qa-content form button[type="submit"]').click());
  await learnerUi.getByRole('heading', {name: editedTitle, exact: true}).waitFor();
  await learnerUi.locator('#videoq-qa-content article').filter({hasText: editedReply}).waitFor();
  const teacherReply = teacherUi.locator('#videoq-qa-content article').filter({hasText: editedReply});
  await teacherReply.getByRole('button', {name: /^(Delete|削除)$/}).click();
  await uiAction(teacherPage, 'qa', 'deleteReply', () => teacherUi.locator('dialog.local-videoq-confirm')
    .getByRole('button', {name: /^(Delete|削除)$/}).click());
  await teacherUi.waitForFunction(() => document.querySelectorAll('#videoq-qa-content article').length === 0
    && document.querySelector('#videoq-course-qa').getAttribute('aria-busy') === 'false');
  await learnerPage.locator('#videoq-course-qa summary').click();
  await teacherPage.locator('#videoq-course-qa summary').click();
  return questionId;
}
async function questionAccess(frame, questionId, expected) {
  const result = await frame.evaluate(questionId => window.__cpuRead('qa', {
    action: 'get', questionId, limit: 20, offset: 0,
  }), questionId);
  // Moodle core may require login before the proxy (401); current capability
  // and VideoQ domain refusals use403. Transport failures are never denials.
  if (expected === 403) assert([401, 403].includes(result.status));
  else assert.equal(result.status, expected);
  if (expected === 200) assert.equal(result.body.data.question.id, questionId);
}
async function deleteOwnQuestion(page, frame) {
  await page.locator('#videoq-course-qa summary').click();
  await frame.getByRole('button', {name: /^(Delete|削除)$/}).click();
  await uiAction(page, 'qa', 'deleteQuestion', () => frame.locator('dialog.local-videoq-confirm')
    .getByRole('button', {name: /^(Delete|削除)$/}).click());
  await frame.getByRole('button', {name: /^(Ask the course|質問を投稿)$/}).waitFor();
  const empty = await frame.evaluate(() => window.__cpuRead('qa', {action: 'list', limit: 20, offset: 0}));
  assert.equal(empty.status, 200); assert.equal(empty.body.data.total, 0);
  await page.locator('#videoq-course-qa summary').click();
}
async function conversationAccess(frame, conversationId, expected) {
  const result = await frame.evaluate(conversationId => window.__cpuRead('conversations', {
    action: 'get', conversationId, limit: 50,
  }), conversationId);
  // Moodle core may require login before the proxy (401); current capability
  // and VideoQ domain refusals use403. Transport failures are never denials.
  if (expected === 403) assert([401, 403].includes(result.status));
  else assert.equal(result.status, expected);
  if (expected === 200) assert.equal(result.body.id, conversationId);
}
function assertExportFields(value) {
  if (value === null || typeof value !== 'object') return;
  const forbidden = /^(?:feedbackId|feedbackToken|chatLogId|threadId|checkpointId|ownerUserId|subjectKey|retrievedContexts|sessionHash)$/;
  for (const [key, item] of Object.entries(value)) {
    assert(!forbidden.test(key), 'Conversation download omits internal and authentication fields');
    assertExportFields(item);
  }
}
async function exportPersonalConversation(page, frame, conversationId, videoId, question) {
  const [download] = await Promise.all([page.waitForEvent('download'), frame.getByRole('button', {
    name: /^(Download conversation|会話をダウンロード)$/,
  }).click()]);
  const records = readFileSync(await download.path(), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].type, 'conversation');
  assert.equal(records[0].format, 'videoq-personal-conversation-v1');
  assert.equal(records[0].id, conversationId);
  assertExportFields(records);
  const turns = records.filter(record => record.type === 'turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, question);
  assert.match(turns[0].answer.segments.map(segment => segment.text).join(''), /住所/);
  assert(turns[0].answer.sources.length > 0 && turns[0].answer.sources.every(source => source.video_id === videoId));
  // Download contents stay in the private browser temporary directory and are
  // never part of the public artifact allowlist.
}
async function deletePersonalConversation(page, frame, conversationId, digest) {
  const before = conversationStorage(digest);
  assert.equal(before.conversations, 1); assert.equal(before.turns, 1); assert.equal(before.scopes, 1);
  assert(before.checkpoints + before.blobs + before.writes > 0, 'Real model memory exists before deleting it');
  await page.locator('#videoq-personal-history summary').click();
  await frame.getByRole('button', {name: /^(Read|読む)$/}).click();
  await frame.getByRole('button', {name: /^(Delete conversation|会話を削除)$/}).click();
  await uiAction(page, 'conversations', 'delete', () => frame.locator('dialog.local-videoq-confirm')
    .getByRole('button', {name: /^(Delete conversation|会話を削除)$/}).click());
  await frame.getByText(/^(No saved conversations yet\.|保存済みの会話はありません。)$/).waitFor();
  await conversationAccess(frame, conversationId, 404);
  assert.deepEqual(conversationStorage(digest), {conversations: 0, turns: 0, scopes: 0, checkpoints: 0, blobs: 0, writes: 0});
  await frame.getByRole('button', {name: /^(New conversation|新しい会話)$/}).click();
  await page.waitForFunction(() => document.querySelectorAll('#videoq-native-messages .answer').length === 0
    && !document.querySelector('#videoq-native-controls').disabled);
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
  const learnerUi = await nativePage(learnerPage);
  await learnerPage.locator('#videoq-native-question').waitFor();
  await learnerPage.waitForFunction(() => !document.querySelector('#videoq-native-controls').disabled);
  assert((await materials(learnerPage)).payload.videos.some(video => video.videoId === actual.videoId));
  assert.equal(await learnerPage.locator('#videoq-course-reports').isVisible(), false);
  assert.equal((await learnerUi.evaluate(period => window.__cpuRead('reports', period), period)).status, 403);
  assert.equal((await materials(learnerPage, 'transcript', sentinel.videoId)).ok, false);
  assert.equal((await materials(learnerPage)).ok, true);
  report.phases.push('fresh-learner-ready-and-owner-sentinel-denied');

  stage('real-native-question');
  const question = '動画では、インターネットで「敵対的環境コース」を検索すると何の住所が出てくると述べていますか？';
  const streamResponse = learnerPage.waitForResponse(response => new URL(response.url()).pathname === '/local/videoq/stream.php');
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
  const rangeBody = await range.body(), rangeHeaders = range.headers();
  const contentType = (rangeHeaders['content-type'] ?? '').split(';')[0].toLowerCase();
  const prefix = rangeBody.subarray(0, 1024).toString('utf8');
  const encoding = rangeHeaders['content-encoding'] ?? 'identity';
  report.mediaRange = mediaRangeEvidence({httpStatus: range.status(), bodyBytes: rangeBody.length,
    declaredBytes: Number(rangeHeaders['content-length'] ?? NaN),
    offloaded: rangeHeaders['x-moodle-media-offload'] === '1',
    rangeMatches: /^bytes 0-15\/[1-9][0-9]*$/.test(rangeHeaders['content-range'] ?? ''),
    mp4Prefix: rangeBody.subarray(4, 8).toString('ascii') === 'ftyp',
    htmlLike: /^\s*<(?:!doctype|html|br|b)[\s>]/i.test(prefix),
    developerWarning: /Warning|Notice|Deprecated|Debugging/i.test(prefix),
    contentKind: contentType.startsWith('video/') ? 'video' : contentType === 'text/html' ? 'html'
      : contentType === 'multipart/byteranges' ? 'multipart' : 'other',
    encoding: ['identity', 'gzip', 'br', 'zstd'].includes(encoding) ? encoding : 'other'});
  assert.equal(range.status(), 206); assert.equal(rangeBody.length, 16);
  assert.equal(range.headers()['x-moodle-media-offload'], '1');
  await media.evaluate((video, seconds) => {video.muted = true; video.currentTime = Math.min(video.duration - 0.25, seconds + 3);}, seconds);
  await learnerPage.locator('#videoq-native-messages .answer .citation').first().click();
  await learnerPage.waitForFunction(seconds => Math.abs(document.querySelector('video#videoq-player, #videoq-player video').currentTime - seconds) < 0.75, seconds);
  await media.evaluate(async video => {await video.play();});
  await learnerPage.waitForFunction(seconds => document.querySelector('video#videoq-player, #videoq-player video').currentTime > seconds + 0.1, seconds);
  assert.equal(await media.evaluate(video => video.error?.code ?? null), null);
  const feedback = waitLearningResponse(learnerPage, 'feedback');
  await learnerPage.locator('#videoq-native-messages .answer [data-feedback="good"]').last().click();
  assert.equal((await feedback).status, 200);
  report.phases.push('real-streamed-answer-citation-seek-decode-feedback');

  stage('personal-history');
  await learnerPage.locator('#videoq-personal-history summary').click();
  await learnerUi.locator('#videoq-personal-history-content article').first().waitFor();
  const personal = await uiAction(learnerPage, 'conversations', 'get', () => learnerUi.getByRole('button', {name: /^(Read|読む)$/}).first().click());
  const conversationId = personal.id;
  const memoryDigest = conversationDigest(conversationId);
  await learnerUi.locator('.personal-turn').first().waitFor();
  assert.match(await learnerUi.locator('#videoq-personal-history-content').innerText(), /住所/);
  await exportPersonalConversation(learnerPage, learnerUi, conversationId, actual.videoId, question);
  await learnerUi.getByRole('button', {name: /Continue this conversation|この会話を続ける/}).click();
  await learnerPage.locator('#videoq-native-messages .answer .citation').first().waitFor();
  report.phases.push('nonempty-personal-history-export-and-resume');

  stage('native-transcript');
  await nativeTranscriptFlow(learnerPage, actual.videoId);
  report.phases.push('actual-native-transcript-reading-refresh-and-seek');
  await teacherPage.goto(state.lessonUrl);
  const teacherUi = await nativePage(teacherPage);
  await conversationAccess(teacherUi, conversationId, 404);
  stage('teacher-management');
  await teacherManagementFlow(teacherPage, teacherUi, learnerUi, actual, async () => {
    const retained = await learner.request.get(mediaUrl, {headers: {Range: 'bytes=0-15'}});
    assert.equal(retained.status(), 206);
    assert.deepEqual(await retained.body(), await range.body(), 'Teacher clear retains the original Moodle media');
  });
  report.phases.push('actual-teacher-description-reindex-confirmed-clear-and-original-asr-restore');
  stage('course-tags');
  await courseTagFlow(teacherPage, teacherUi, learnerPage, learnerUi, actual.videoId);
  report.phases.push('actual-course-tags-crud-assignment-learner-denial-and-transcript');
  stage('human-qa');
  const questionId = await courseQaFlow(teacherPage, teacherUi, learnerPage, learnerUi, actual.videoId);
  report.phases.push('actual-human-qa-post-reply-edit-votes-moderation-and-cross-author-denial');

  stage('positive-reports');
  period.to = new Date().toISOString().slice(0, 10);
  await teacherPage.locator('#videoq-course-reports summary').click();
  await teacherUi.locator('#videoq-reports-content tbody tr').first().waitFor();
  const summary = await teacherUi.evaluate(period => window.__cpuRead('reports', period), period);
  assert.equal(summary.status, 200); assert.equal(summary.body.period.timezone, 'UTC');
  assert.deepEqual(summary.body.totals, {questions: 1, good: 1, bad: 0, none: 0});
  const download = teacherPage.waitForEvent('download');
  await teacherUi.locator('#videoq-reports-export').click();
  const csv = await download;
  const csvPath = await csv.path();
  const csvText = readFileSync(csvPath, 'utf8');
  assert(csvText.startsWith('date,questions,good,bad,unrated\n'));
  assert(csvText.split('\n').length > 2);
  fixture('deny-reports');
  const revoked = waitLearningResponse(teacherPage, 'reports', 'summary');
  await teacherUi.locator('#videoq-reports-form button[type="submit"]').click();
  assert.equal((await revoked).status, 403);
  await teacherUi.waitForFunction(() => document.querySelector('#videoq-reports-content').children.length === 0);
  fixture('allow-reports');
  assert.equal((await materials(teacherPage)).payload.permissions.viewReports, true);
  assert.equal((await teacherUi.evaluate(period => window.__cpuRead('reports', period), period)).status, 200);
  report.phases.push('positive-utc-report-csv-and-same-session-capability-revocation');

  stage('same-session-source-enrolment');
  fixture('hide'); assert.equal((await materials(learnerPage)).ok, false);
  await questionAccess(learnerUi, questionId, 403);
  await conversationAccess(learnerUi, conversationId, 403);
  assert.notEqual((await learner.request.get(mediaUrl, {headers: {Range: 'bytes=0-15'}})).status(), 206);
  assert.equal((await materials(teacherPage)).ok, true);
  fixture('show'); assert.equal((await materials(learnerPage)).ok, true);
  await questionAccess(learnerUi, questionId, 200);
  await conversationAccess(learnerUi, conversationId, 200);
  fixture('suspend'); assert.equal((await materials(learnerPage)).ok, false);
  await questionAccess(learnerUi, questionId, 403);
  await conversationAccess(learnerUi, conversationId, 403);
  assert.notEqual((await learner.request.get(mediaUrl, {headers: {Range: 'bytes=0-15'}})).status(), 206);
  fixture('resume'); assert.equal((await materials(learnerPage)).ok, true);
  await questionAccess(learnerUi, questionId, 200);
  await conversationAccess(learnerUi, conversationId, 200);
  await deleteOwnQuestion(learnerPage, learnerUi);
  report.phases.push('actual-human-qa-current-source-enrolment-and-own-deletion');
  assert.equal(await learnerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await learnerPage.screenshot({path: join(dirname(resultPath), 'moodle-native-mobile.png'), fullPage: true});
  report.phases.push('same-session-hidden-source-enrolment-current-authority');
  stage('personal-deletion');
  await deletePersonalConversation(learnerPage, learnerUi, conversationId, memoryDigest);
  const erasedReport = await teacherUi.evaluate(period => window.__cpuRead('reports', period), period);
  assert.equal(erasedReport.status, 200);
  assert.deepEqual(erasedReport.body.totals, {questions: 0, good: 0, bad: 0, none: 0});
  report.phases.push('actual-own-conversation-delete-model-memory-erasure-and-report-refresh');
  const privacy = await corePrivacy({learner, learnerPage, learnerUi, teacher, teacherUi,
    videoId: actual.videoId, courseId: state.courseId, lessonUrl: state.lessonUrl, nativePage,
    stage, phase: name => report.phases.push(name), fixture, uiAction, login, context,
    memoryDigest: conversationDigest, memoryState: conversationStorage, memoryRecords: conversationMemoryRecords,
    verifyArchive: verifyPrivacyArchive, materialState: material, sentinelState: standaloneIndexState, reportPeriod: period});
  report.nativeTransport = await nativeBrowserEvidence();
  Object.assign(report, {status: 'passed', stage: 'complete', transcript: actual.transcript,
    managedVideoId: actual.videoId, standaloneSentinelDenied: true, asrChunks: actual.asrChunks,
    vectorCount: actual.vectorCount, embeddingTable, answer: text, sourceVideoIds: sources.map(source => source.video_id),
    requestedCitationSeconds: seconds, reports: summary.body.totals, privacy,
    limits: ['Public File + local CPU fixture only; cloud YouTube/provider, independent-site restore, restricted worker and wider feature inventory remain separate gates.']});
  writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  writeFileSync(join(dirname(resultPath), 'moodle-stage.json'), JSON.stringify({
    stage: report.stage, completed: report.phases, failure: browserFailure(error,
      report.stage.startsWith('core-privacy-') ? new URL('./privacy.mjs', import.meta.url).href : import.meta.url),
    ...(report.tagsUi ? {tagsUi: tagUiEvidence(report.tagsUi)} : {}),
    ...(report.tagClick ? {tagClick: clickActionabilityEvidence(report.tagClick)} : {}),
    ...(report.mediaRange ? {mediaRange: mediaRangeEvidence(report.mediaRange)} : {}),
  }) + '\n');
  throw error;
} finally {
  await browser.close();
}
