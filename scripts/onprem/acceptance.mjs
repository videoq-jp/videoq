// Disposable single-server acceptance. Uses a deterministic private AI fixture.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { labFetch as fetch, closeLabHttp } from '../../.github/onprem-lab/http.mjs';

const origin = 'http://localhost:18090';
const storage = 'http://localhost:18091';
const password = 'Local-validation-only-2026!';
const [mode, statePath, fixturePath] = process.argv.slice(2);
let cookie;

async function rpc(name, input, query = false) {
  const response = await fetch(origin + '/api/trpc/' + name + (query ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''), {
    method: query ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    ...(!query ? { body: JSON.stringify(input) } : {}),
  });
  // Do not include response bodies that could contain credentials in failures.
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  return (await response.json()).result.data;
}

async function answer(courseId) {
  const messages = [{ role: 'user', content: 'Where does VideoQ run?' }];
  const result = await rpc('chat.send', { messages, courseId });
  assert(result.answer.segments.some(segment => segment.text.includes('VideoQ')));
  assert.equal(result.answer.sources.length, 1);
  const response = await fetch(origin + '/api/chat/messages/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ messages, course_id: courseId }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert(events.some(event => event.type === 'citation'));
  assert(events.some(event => event.type === 'done'));
  assert(!events.some(event => event.type === 'error'));
  return result.answer.sources[0];
}

async function playback(videoId, source) {
  assert.equal(source.video_id, videoId);
  const match = /^(\d+):(\d{2}):(\d{2}),(\d{3})$/.exec(source.start_time);
  assert(match, 'citation timestamp');
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const login = await context.request.post(origin + '/api/auth/sign-in/email', {
      headers: { Origin: origin }, data: { email: 'onprem-lab@example.com', password },
    });
    assert.equal(login.status(), 200);
    const response = await context.request.get(origin + '/api/trpc/videos.get', { params: { input: JSON.stringify({ id: videoId }) } });
    assert.equal(response.status(), 200);
    const video = (await response.json()).result.data;
    const media = new URL(video.file, origin);
    assert([origin, storage].includes(media.origin));
    const range = await context.request.get(media.href, { headers: { Range: 'bytes=0-15' } });
    assert.equal(range.status(), 206);
    assert.equal((await range.body()).length, 16);
    const page = await context.newPage();
    await page.goto(origin + '/ready');
    await page.evaluate(url => {
      document.body.replaceChildren(Object.assign(document.createElement('video'), { src: url, controls: true, muted: true }));
    }, media.href);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await page.evaluate(async position => {
      const element = document.querySelector('video');
      element.currentTime = position;
      await element.play();
    }, seconds);
    await page.waitForFunction(position => document.querySelector('video').currentTime > position + 0.1, seconds);
    assert.equal(await page.locator('video').evaluate(element => element.error), null);
  } finally {
    await browser.close();
  }
}

try {
  if (mode === 'activate') {
    const activation = JSON.parse(readFileSync(statePath, 'utf8')).activation_url;
    assert.equal(new URL(activation).origin, origin);
    const response = await fetch(activation, { redirect: 'manual' });
    const token = new URL(response.headers.get('location')).searchParams.get('token');
    assert(token);
    const reset = await fetch(origin + '/api/auth/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token, newPassword: password }),
    });
    assert.equal(reset.status, 200);
    console.log('Single-use administrator setup completed');
  } else {
    const response = await fetch(origin + '/api/auth/sign-in/email', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email: 'onprem-lab@example.com', password }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert(cookie);
    let state;
    if (mode === 'upload') {
      const bytes = readFileSync(fixturePath);
      const created = await rpc('videos.requestUpload', { filename: 'single-server.mp4', contentType: 'video/mp4', fileSize: bytes.length, title: 'Single-server acceptance' });
      assert.equal(new URL(created.upload_url).origin, storage);
      const uploaded = await fetch(created.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: bytes });
      assert.equal(uploaded.status, 200);
      const videoId = created.video.id;
      await rpc('videos.confirmUpload', { id: videoId });
      let video;
      for (let attempt = 0; attempt < 120; attempt++) {
        video = await rpc('videos.get', { id: videoId }, true);
        if (video.status === 'completed') break;
        assert.notEqual(video.status, 'error');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(video.status, 'completed');
      assert(video.transcript.includes('VideoQ runs on Kubernetes.'));
      const course = await rpc('courses.create', { name: 'Single-server acceptance' });
      await rpc('memberships.addVideo', { courseId: course.id, videoId });
      state = { videoId, courseId: course.id };
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    } else {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal((await rpc('videos.get', { id: state.videoId }, true)).status, 'completed');
    }
    const source = await answer(state.courseId);
    await playback(state.videoId, source);
    console.log(`${mode}: authenticated video, transcription, vectors, cited Q&A, SSE and Chromium playback passed`);
  }
} finally {
  await closeLabHttp();
}
