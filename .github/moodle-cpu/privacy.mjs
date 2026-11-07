import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {waitLearningResponse} from './native-browser.mjs';

const MOODLE = 'https://moodle.localhost:18443';
const question = '動画では、インターネットで「敵対的環境コース」を検索すると何の住所が出てくると述べていますか？';
const title = 'CPU privacy learner question';
const subjectText = 'CPU privacy subject text to erase';
const peerText = 'CPU privacy teacher reply retained';
const requestsUrl = MOODLE + '/admin/tool/dataprivacy/mydatarequests.php';
const mailDisabledWarning = 'Not sending email due to $CFG->noemailever config setting';
const read = (frame, path, body) => frame.evaluate(({path, body}) => window.__cpuRead(path, body), {path, body});
async function panel(page, id, open) {
  const details = page.locator(id);
  if ((await details.getAttribute('open') !== null) !== open) await details.locator('summary').click();
}

export function suppressedMailContinuation(currentUrl, href, warnings) {
  const current = new URL(currentUrl);
  assert.equal(current.origin, MOODLE);
  assert.equal(current.pathname, '/admin/tool/dataprivacy/createdatarequest.php');
  assert(Array.isArray(warnings) && warnings.length > 0 && warnings.length <= 16);
  assert(warnings.every(value => typeof value === 'string' && value.trim().startsWith(mailDisabledWarning)));
  assert.equal(typeof href, 'string');
  const target = new URL(href, current);
  assert.equal(target.href, requestsUrl);
  return target.href;
}

export async function corePrivacy(h) {
  const {learner, learnerPage, learnerUi, teacher, teacherUi, videoId, lessonUrl, nativePage,
    stage, phase, fixture, uiAction, login, context, memoryDigest, memoryState, memoryRecords,
    verifyArchive, materialState, sentinelState, reportPeriod} = h;
  stage('core-privacy-real-question');
  const mediaBefore = materialState(), sentinelBefore = sentinelState();
  const stream = learnerPage.waitForResponse(r => new URL(r.url()).pathname === '/local/videoq/stream.php');
  await learnerPage.locator('#videoq-native-question').fill(question);
  await learnerPage.locator('#videoq-native-send').click();
  const response = await stream;
  assert.equal(response.status(), 200);
  const events = (await response.text()).split('\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5)));
  assert(events.some(e => e.type === 'done') && !events.some(e => e.type === 'error'));
  assert.match(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), /住所/);
  const sources = events.filter(e => e.type === 'source').map(e => e.source);
  assert(sources.length > 0 && sources.every(s => s.video_id === videoId));
  await learnerPage.locator('#videoq-native-messages .answer .citation').first().waitFor();
  const feedback = waitLearningResponse(learnerPage, 'feedback');
  await learnerPage.locator('#videoq-native-messages .answer [data-feedback="good"]').last().click();
  assert.equal((await feedback).status, 200);
  await panel(learnerPage, '#videoq-personal-history', true);
  await learnerUi.locator('#videoq-personal-history').getByRole('button', {name: /^(Refresh|更新)$/}).click();
  await learnerUi.locator('#videoq-personal-history-content article').first().waitFor();
  const conversation = await uiAction(learnerPage, 'conversations', 'get', () => learnerUi.getByRole('button', {name: /^(Read|読む)$/}).first().click());
  const digest = memoryDigest(conversation.id);
  const before = memoryState(digest);
  assert.equal(before.conversations, 1); assert.equal(before.turns, 1); assert.equal(before.scopes, 1);
  assert(before.checkpoints > 0 && before.blobs > 0 && before.writes > 0, 'Actual model state exists in every official store');
  const expectedMemory = memoryRecords(digest, conversation.id);
  await panel(learnerPage, '#videoq-personal-history', false);
  phase('actual-second-ai-conversation-and-model-memory-for-core-privacy');

  stage('core-privacy-peer-data');
  await panel(learnerPage, '#videoq-course-qa', true);
  await learnerUi.getByRole('button', {name: /^(Ask the course|質問を投稿)$/}).click();
  await learnerUi.locator('#videoq-qa-input-title').fill(title);
  await learnerUi.locator('#videoq-qa-input-body').fill(subjectText);
  await learnerUi.locator('#videoq-qa-input-lesson').selectOption(String(videoId));
  const asked = await uiAction(learnerPage, 'qa', 'ask', () => learnerUi.locator('#videoq-qa-content form button[type=submit]').click());
  const questionId = asked.data.id;
  // The previous rehearsal leaves its selected (now deleted) question in the
  // original teacher frame. Use a normal new Moodle tab for peer posting, while
  // retaining that original credential for the post-erasure peer-access checks.
  const peerPage = await teacher.newPage();
  await peerPage.goto(lessonUrl);
  const peerUi = await nativePage(peerPage);
  await panel(peerPage, '#videoq-course-qa', true);
  await peerUi.locator('#videoq-course-qa').getByRole('button', {name: /^(Refresh|更新)$/}).click();
  await peerUi.getByRole('button', {name: title, exact: true}).click();
  await peerUi.getByRole('button', {name: /^(Reply|返信する)$/}).click();
  await peerUi.locator('#videoq-qa-input-body').fill(peerText);
  const replied = await uiAction(peerPage, 'qa', 'reply', () => peerUi.locator('#videoq-qa-content form button[type=submit]').click());
  const replyId = replied.data.id;
  const peerBefore = await read(teacherUi, 'qa', {action: 'get', questionId, limit: 20, offset: 0});
  assert.equal(peerBefore.status, 200);
  const originalReply = peerBefore.body.data.replies.find(reply => reply.id === replyId);
  assert.equal(originalReply?.body, peerText);
  assert.equal(originalReply.author.source, 'moodle');
  assert(originalReply.author.name && originalReply.author.name !== peerBefore.body.data.question.author.name);
  reportPeriod.to = new Date().toISOString().slice(0, 10);
  const totals = await read(teacherUi, 'reports', reportPeriod);
  assert.equal(totals.status, 200);
  assert.deepEqual(totals.body.totals, {questions: 1, good: 1, bad: 0, none: 0});

  const configuration = fixture('privacy-setup');
  assert.equal(configuration.manualApproval, true);
  let admin;
  try {
    admin = await context();
    const adminPage = await login(admin, 'admin');
    const selfPage = await learner.newPage();
    selfPage.setDefaultTimeout(30_000);
    async function request(kind, label) {
      await selfPage.goto(MOODLE + '/admin/tool/dataprivacy/createdatarequest.php', {waitUntil: 'domcontentloaded'});
      await selfPage.locator('select[name=type]').selectOption({label});
      await selfPage.locator('textarea[name=comments]').fill(configuration.comments[kind]);
      await Promise.all([selfPage.waitForEvent('domcontentloaded'),
        selfPage.getByRole('button', {name: 'Save changes', exact: true}).click()]);
      if (selfPage.url() !== requestsUrl) {
        // Moodle deliberately disables automatic redirects after its known
        // noemailever debugging message. Follow only its real, same-origin
        // Continue link, after confirming that core created the owned request.
        assert(fixture('privacy-status').requests[kind], 'Submitted core request exists before Continue');
        const continuation = selfPage.getByRole('link', {name: 'Continue', exact: true});
        const target = suppressedMailContinuation(selfPage.url(), await continuation.getAttribute('href'),
          await selfPage.locator('.debuggingmessage').allTextContents());
        await Promise.all([selfPage.waitForURL(u => u.href === target, {waitUntil: 'domcontentloaded'}),
          continuation.click()]);
      }
      assert.equal(selfPage.url(), requestsUrl);
      let status = fixture('privacy-status').requests[kind];
      assert(status, 'Actual core request exists');
      for (const task of status.tasks.filter(t => t.kind === 'initiate')) fixture('privacy-task', {kind, taskId: task.id});
      status = fixture('privacy-status').requests[kind];
      assert.equal(status.awaitingApproval, true);
      assert.equal(fixture('privacy-status').subjectDeleted, false);
      assert.deepEqual(memoryState(digest), before, 'Pending core requests retain original model memory');
      const pendingQuestion = await read(learnerUi, 'qa', {action: 'get', questionId, limit: 20, offset: 0});
      assert.equal(pendingQuestion.status, 200);
      assert.equal(pendingQuestion.body.data.question.title, title);
      assert.equal(pendingQuestion.body.data.question.body, subjectText);
      const denied = await learner.request.get(MOODLE + '/admin/tool/dataprivacy/datarequests.php');
      assert([403, 404].includes(denied.status()), 'Learner cannot approve privacy requests');
      await adminPage.goto(MOODLE + '/admin/tool/dataprivacy/datarequests.php', {waitUntil: 'domcontentloaded'});
      await adminPage.waitForFunction(() => typeof window.requirejs?.defined === 'function'
        && window.requirejs.defined('theme_boost/loader') && window.requirejs.defined('tool_dataprivacy/requestactions'));
      const row = adminPage.locator('tr').filter({hasText: configuration.comments[kind]});
      await row.locator('.dropdown-toggle').click();
      await row.getByText(/^Approve request(?: \(all data\))?$/).click();
      await adminPage.getByRole('dialog').getByRole('button', {name: 'Approve request', exact: true}).click();
      for (let attempt = 0; attempt < 20; attempt++) {
        status = fixture('privacy-status').requests[kind];
        if (status.approved) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.equal(status.approved, true); assert.equal(status.approvedByAdmin, true);
      assert.equal(status.tasks.filter(t => t.kind === 'process').length, 1);
      fixture('privacy-task', {kind, taskId: status.tasks.find(t => t.kind === 'process').id});
      return fixture('privacy-status').requests[kind];
    }

    stage('core-privacy-export');
    const exported = await request('export', 'Export all of my personal data');
    assert.equal(exported.downloadReady, true); assert.equal(exported.tasks.length, 0);
    await selfPage.goto(MOODLE + '/admin/tool/dataprivacy/mydatarequests.php', {waitUntil: 'domcontentloaded'});
    await selfPage.waitForFunction(() => typeof window.requirejs?.defined === 'function'
      && window.requirejs.defined('theme_boost/loader') && window.requirejs.defined('tool_dataprivacy/myrequestactions'));
    await selfPage.locator('tr').filter({hasText: configuration.comments.export}).locator('.dropdown-toggle').click();
    const downloadLink = selfPage.getByRole('menuitem', {name: 'Download', exact: true});
    const downloadUrl = new URL(await downloadLink.getAttribute('href'), MOODLE);
    assert.equal(downloadUrl.origin, MOODLE);
    const wrongSubject = await teacher.request.get(downloadUrl.href);
    assert([403, 404].includes(wrongSubject.status()), 'Teacher cannot download learner privacy archive');
    const pendingDownload = selfPage.waitForEvent('download');
    await downloadLink.click();
    const download = await pendingDownload;
    const checksum = createHash('sha256').update(readFileSync(await download.path())).digest('hex');
    const verifiedMemory = verifyArchive(await download.path(), {context: String(h.courseId),
      conversationId: conversation.id, records: expectedMemory});
    assert.equal(verifiedMemory.modelRecordsMatched, true);
    assert.equal(checksum, verifiedMemory.archiveSha256);
    const archive = fixture('privacy-export-evidence', {conversationId: conversation.id, question, questionTitle: title});
    assert.equal(checksum, archive.archiveSha256);
    assert.equal(archive.ownedConversationOnly, true); assert.equal(archive.peerTextExcluded, true);
    assert.equal(archive.counts.conversations, 1); assert.equal(archive.counts.turns, 1);
    assert.equal(archive.counts.logs, 1); assert.equal(archive.counts.questions, 1);
    assert.equal(archive.counts.replies, 0, 'Peer reply is outside subject export');
    assert.equal(archive.counts.checkpoints, before.checkpoints);
    assert.equal(archive.counts.checkpoint_blobs, before.blobs);
    assert.equal(archive.counts.checkpoint_writes, before.writes);
    assert.deepEqual(verifiedMemory.counts, {checkpoints: before.checkpoints,
      checkpoint_blobs: before.blobs, checkpoint_writes: before.writes});
    assert.deepEqual(memoryState(digest), before, 'Export retains all original model memory');
    phase('actual-core-approved-ai-history-qa-and-model-memory-export');

    stage('core-privacy-delete');
    const erased = await request('delete', 'Delete all of my personal data');
    assert.equal(erased.deleted, true); assert.equal(erased.tasks.length, 0);
    assert.equal(fixture('privacy-status').subjectDeleted, true);
    assert.deepEqual(memoryState(digest), {conversations: 0, turns: 0, scopes: 0, checkpoints: 0, blobs: 0, writes: 0});
    const peer = await read(teacherUi, 'qa', {action: 'get', questionId, limit: 20, offset: 0});
    assert.equal(peer.status, 200);
    assert.equal(peer.body.data.question.author.name, 'Deleted participant');
    assert.equal(peer.body.data.question.title, '[deleted]');
    assert.equal(peer.body.data.question.body, '[deleted]');
    const retainedReply = peer.body.data.replies.find(reply => reply.id === replyId);
    assert.equal(retainedReply?.body, peerText);
    assert.deepEqual(retainedReply.author, originalReply.author);
    assert.equal((await read(teacherUi, 'qa', {action: 'updateReply', questionId, replyId, body: peerText + ' verified'})).status, 200);
    assert([401, 403].includes((await read(learnerUi, 'conversations', {action: 'get', conversationId: conversation.id, limit: 20})).status));
    assert([401, 403].includes((await read(learnerUi, 'qa', {action: 'ask', title: 'Denied write', body: 'Must not persist', videoId})).status));
    const finalReport = await read(teacherUi, 'reports', reportPeriod);
    assert.equal(finalReport.status, 200);
    assert.deepEqual(finalReport.body.totals, {questions: 0, good: 0, bad: 0, none: 0});
    assert.deepEqual(materialState(), mediaBefore, 'Subject erasure retains shared source/transcript/vectors');
    assert.deepEqual(sentinelState(), sentinelBefore, 'Subject erasure retains standalone owner material');
    phase('actual-core-subject-ai-memory-erasure-peer-retention-and-session-revocation');
    return {archiveSha256: checksum, exported: archive.counts, modelMemoryBefore: {
      checkpoints: before.checkpoints, blobs: before.blobs, writes: before.writes},
      ownModelMemoryErased: true, peerDataRetained: true, originalSubjectSessionDenied: true,
      sharedMaterialsPreserved: true, teacherArchiveDownloadDenied: true, reportsRefreshedToZero: true,
      modelMemoryExportMatched: true};
  } finally {
    try {
      await peerPage.close();
      await admin?.close();
    } finally {
      assert.equal(fixture('privacy-reset').restored, true);
    }
  }
}
