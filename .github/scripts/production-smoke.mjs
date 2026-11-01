import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(new URL('../operations-tools/package.json', import.meta.url));
const { Client } = require('pg');
const { chromium } = require('playwright');
const { createParser } = require('eventsource-parser');
const { verifyStream } = createRequire(import.meta.url)('./production-stream-proof.cjs');
const { hashPassword } = await import(require.resolve('better-auth/crypto'));
const { ORIGIN, synthetic, uploadAllowed, completed, deletable, fixtureValid, waitForCleanup, citedAnswerValid } = createRequire(import.meta.url)('./production-smoke-policy.cjs');
const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000,
  statement_timeout: 30_000, application_name: 'videoq-operations-smoke' });
const verifyAi = process.env.VERIFY_AI_ANSWERS === 'true';
let browser, currentUser, cookie = '', stage = 'public-health';
function progress(value) { stage = value; console.log('Production smoke stage: ' + value); }
const request = (path, options = {}) => fetch(ORIGIN + path, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000) });
async function rpc(procedure, input, mutation = false, timeoutMs = 30_000) {
  const response = await request('/api/trpc/' + procedure + (mutation ? '' : '?input=' + encodeURIComponent(JSON.stringify(input))), {
    signal: AbortSignal.timeout(timeoutMs), method: mutation ? 'POST' : 'GET', headers: { cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
    ...(mutation ? { body: JSON.stringify(input) } : {}),
  });
  const value = await response.json();
  if (!response.ok || !value.result || value.error) throw new Error('RPC failed');
  return value.result.data;
}
async function login(user, password) {
  if (!synthetic(user)) throw new Error('Unsafe synthetic identity');
  const response = await request('/api/auth/sign-in/email', { method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password }),
  });
  if (!response.ok) throw new Error('Synthetic sign-in failed');
  cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  if (!cookie.includes('session_token=')) throw new Error('No signed session');
  await db.query("SELECT videoq_security.smoke_expire($1)", [user.id]);
}
async function cleanup(user) {
  if (!synthetic(user)) throw new Error('Unsafe cleanup target');
  const { rows } = await db.query('SELECT id, status FROM videoq_security.smoke_videos WHERE user_id = $1', [user.id]);
  // Do not race a running worker or orphan its uploads. A later run retries terminal videos.
  if (rows.some(video => !deletable(video.status))) return false;
  const visual = await db.query(`SELECT count(*) FROM videoq_security.smoke_visual_runs r JOIN videoq_security.smoke_videos v ON v.id = r.video_id
    WHERE v.user_id = $1 AND r.status = 'processing'`, [user.id]);
  if (Number(visual.rows[0].count)) return false;
  for (const video of rows) await rpc('videos.delete', { id: Number(video.id) }, true);
  const pending = await db.query(`SELECT count(*) FROM videoq_security.smoke_external_tasks WHERE kind = 'storage_cleanup'
    AND user_id = $1 AND completed_at IS NULL`, [user.id]);
  if (Number(pending.rows[0].count)) return false;
  const courses = await db.query('SELECT id FROM videoq_security.smoke_courses WHERE user_id = $1', [user.id]);
  for (const course of courses.rows) await rpc('courses.delete', { id: Number(course.id) }, true);
  const removed = await db.query('SELECT videoq_security.smoke_delete($1) AS removed', [user.id]);
  return removed.rows[0].removed === true;
}
let report = { status: 'error', summary: '本番の動作確認を完了できませんでした。', details: [] };
try {
  for (const path of ['/health', '/ready']) {
    const response = await request(path);
    const body = await response.json();
    if (!response.ok || !['ok', 'ready'].includes(body.data?.status) || (path === '/ready' && body.data.db !== 'ok')) throw new Error('Health failed');
  }
  progress('database-and-cleanup');
  await db.connect();
  const old = await db.query(`SELECT id, username, email, name, role, quota_source FROM videoq_security.smoke_users
    WHERE username = 'ops_smoke_' || id AND email = id || '@example.invalid'
      AND name = 'VideoQ automated smoke check' AND role = 'user' AND quota_source = 'admin'
    ORDER BY created_at LIMIT 10`);
  for (const user of old.rows) {
    if (!synthetic(user)) continue;
    const password = randomBytes(32).toString('base64url');
    const hash = await hashPassword(password);
    await db.query("SELECT videoq_security.smoke_password($1,$2)", [user.id, hash]);
    await login(user, password);
    if (!await waitForCleanup(() => cleanup(user), delay)) throw new Error('Earlier smoke video still processing; no additional upload');
  }
  const id = randomUUID();
  const password = randomBytes(32).toString('base64url');
  currentUser = { id, username: 'ops_smoke_' + id, email: id + '@example.invalid',
    name: 'VideoQ automated smoke check', role: 'user', quota_source: 'admin' };
  const hash = await hashPassword(password);
  await db.query('BEGIN');
  await db.query('SELECT videoq_security.smoke_create($1::uuid,$2,$3)', [id, hash, verifyAi]);
  await db.query('COMMIT');
  progress('synthetic-sign-in');
  await login(currentUser, password);
  progress('upload');
  const bytes = await fs.readFile(new URL('../operations-tools/fixtures/smoke.mp4', import.meta.url));
  if (!fixtureValid(bytes)) throw new Error('Unreviewed fixture');
  const title = 'Operations smoke ' + id;
  const upload = await rpc('videos.requestUpload', { filename: 'operations-smoke.mp4', title,
    description: 'Automated short-lived operations check', contentType: 'video/mp4', fileSize: bytes.length }, true);
  if (!uploadAllowed(upload.upload_url)) throw new Error('Unexpected upload origin');
  const put = await fetch(upload.upload_url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'video/mp4' },
    redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new Error('Upload failed');
  await rpc('videos.confirmUpload', { id: upload.video.id }, true);
  progress('video-processing');
  let video;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    video = await rpc('videos.get', { id: upload.video.id });
    if (video.visual_processing?.status === 'error') throw new Error('Visual processing failed');
    if (completed(video)) break;
    if (video.status === 'error') throw new Error('Processing failed');
    await delay(Math.min(20_000, Math.max(0, deadline - Date.now())));
  }
  if (!video || !completed(video) || !video.transcript?.trim()) throw new Error('Video processing did not finish');
  const embedded = await db.query('SELECT count(*) FROM videoq_security.smoke_scene_embeddings WHERE user_id = $1 AND video_id = $2', [id, video.id]);
  if (Number(embedded.rows[0].count) < 1) throw new Error('No scene embeddings');
  if (verifyAi) {
    progress('cited-question-answer');
    const course = await rpc('courses.create', { name: title, description: 'Temporary migration verification' }, true);
    await rpc('memberships.addVideo', { courseId: course.id, videoId: video.id }, true);
    const answer = await rpc('chat.send', { courseId: course.id,
      messages: [{ role: 'user', content: 'What is said in this video? Summarize it and cite the transcript evidence.' }] }, true, 180_000);
    if (!citedAnswerValid(answer, Number(video.id))) throw new Error('No cited answer from the uploaded video');
    for (const scoped of [true, false]) {
      progress(scoped ? 'cited-streaming-answer' : 'unscoped-streaming-answer');
      const response = await request('/api/chat/messages/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
        body: JSON.stringify({ messages: [{ role: 'user', content: scoped
          ? 'Summarize what is said in this video and cite its transcript evidence.'
          : 'Briefly explain what a video transcript is.' }], ...(scoped ? { course_id: course.id } : {}) }),
        signal: AbortSignal.timeout(180_000),
      });
      const chatLogId = await verifyStream(response, createParser, scoped ? Number(video.id) : undefined);
      if (scoped) {
        const stored = await db.query('SELECT id FROM videoq_security.smoke_chat_logs WHERE id = $1 AND user_id = $2', [chatLogId, id]);
        if (stored.rows.length !== 1) throw new Error('Streamed answer persistence not confirmed');
      }
    }
  }
  progress('browser');
  browser = await chromium.launch(process.env.VIDEOQ_BUNDLED_CHROMIUM === 'true' ? {} : { channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', () => errors.push(true));
  const publicPage = await page.goto(ORIGIN + '/login', { waitUntil: 'networkidle', timeout: 60_000 });
  if (!publicPage.ok() || await page.locator('input[name="username"]').count() !== 1 ||
      await page.locator('input[name="password"]').count() !== 1) throw new Error('Login UI failed');
  await context.addCookies(cookie.split('; ').map(value => {
    const at = value.indexOf('=');
    return { name: value.slice(0, at), value: value.slice(at + 1), url: ORIGIN, httpOnly: true, secure: true, sameSite: 'Lax' };
  }));
  await page.goto(ORIGIN + '/videos', { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByText(title, { exact: true }).first().waitFor({ timeout: 30_000 });
  if (errors.length) throw new Error('Browser JavaScript error');
  report = { status: 'ok', summary: '本番の画面・API・DB・短い動画の処理・文字起こし・埋め込みを確認しました。' + (verifyAi ? ' 検索・引用付き Q&A・講座あり／なしのストリーミングも確認しました。' : ''), details: [] };
} catch {
  try { await db.query('ROLLBACK'); } catch { /* connection may be unavailable */ }
  report.details = ['- 失敗した段階: `' + stage + '`。認証情報や利用者のデータはログに出力していません。'];
} finally {
  console.log('Production smoke checks: ' + report.status);
  if (browser) await browser.close().catch(() => {});
  if (currentUser) {
    try {
      if (!await waitForCleanup(() => cleanup(currentUser), delay)) throw new Error('Cleanup pending');
      console.log('Production smoke cleanup: complete');
    } catch {
      console.log('Production smoke cleanup: incomplete');
      report.status = 'error';
      report.summary = '本番の動作確認またはテストデータの削除を完了できませんでした。';
      report.details.push('- テストデータが残っています。次回の実行で再確認し、処理中の動画は削除しません。');
    }
  }
  await db.end().catch(() => {});
  await fs.writeFile('operations-report.json', JSON.stringify(report));
}
