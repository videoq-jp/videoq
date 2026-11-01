// Explicit opt-in acceptance against a disposable site and real inference.
// Usage: node model-e2e.mjs OUTPUT_DIR ORIGIN; public ja.mp4/en.mp4 live in OUTPUT_DIR.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {labFetch as fetch, closeLabHttp} from './http.mjs';

const output = process.argv[2];
const origin = process.argv[3] || 'http://127.0.0.1:28787';
assert(output && new URL(origin).hostname === '127.0.0.1', 'Use an explicit disposable localhost site');
const password = 'Local-model-validation-only-2026!';
const statePath = join(output, 'model-e2e-state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : {videos: {}};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const headers = {'Content-Type': 'application/json', Origin: origin};
let cookie;
async function rpc(name, input, query = false, locale = 'en') {
  const response = await fetch(origin + '/api/trpc/' + name + (query ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''), {
    method: query ? 'GET' : 'POST', headers: {...headers, Cookie: cookie, 'Accept-Language': locale},
    ...(!query ? {body: JSON.stringify(input)} : {}),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.result.data;
}

try {
  if (!state.activated) {
    const setup = JSON.parse(readFileSync(join(output, 'activation.json')));
    const activation = new URL(setup.activation_url);
    assert.equal(activation.origin, origin);
    const redirect = await fetch(activation, {redirect: 'manual'});
    const token = new URL(redirect.headers.get('location')).searchParams.get('token');
    assert(token);
    const reset = await fetch(origin + '/api/auth/reset-password', {method: 'POST', headers, body: JSON.stringify({token, newPassword: password})});
    assert.equal(reset.status, 200);
    state.activated = true;
    save();
  }
  const auth = await fetch(origin + '/api/auth/sign-in/email', {method: 'POST', headers,
    body: JSON.stringify({email: 'model-validation@example.invalid', password})});
  assert.equal(auth.status, 200);
  cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie);
  for (const language of ['ja', 'en']) {
    if (!state.videos[language]) {
      const bytes = readFileSync(join(output, language + '.mp4'));
      const upload = await rpc('videos.requestUpload', {filename: language + '.mp4', contentType: 'video/mp4',
        fileSize: bytes.length, title: 'FLEURS ' + language + ' real model acceptance', transcriptionLanguage: language});
      assert.equal(new URL(upload.upload_url).origin, 'http://127.0.0.1:29000');
      assert((await fetch(upload.upload_url, {method: 'PUT', headers: {'Content-Type': 'video/mp4'}, body: bytes})).ok);
      await rpc('videos.confirmUpload', {id: upload.video.id});
      state.videos[language] = {id: upload.video.id};
      save();
    }
    const started = performance.now();
    let video;
    for (let attempt = 0; attempt < 900; attempt++) {
      video = await rpc('videos.get', {id: state.videos[language].id}, true);
      assert.notEqual(video.status, 'error', JSON.stringify(video));
      if (video.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(video.status, 'completed');
    assert.match(video.transcript, language === 'ja' ? /インターネット|検索/ : /cabbage/i);
    assert.match(video.transcript, language === 'ja' ? /住所/ : /acid|alkalin|basic/i);
    state.videos[language] = {...state.videos[language], transcript: video.transcript, processingSeconds: (performance.now() - started) / 1000};
    save();
    console.log(language + ': real transcription and indexing passed');
  }
  if (!state.courseId) {
    const course = await rpc('courses.create', {name: 'Japanese and English real models'});
    state.courseId = course.id;
    for (const video of Object.values(state.videos)) await rpc('memberships.addVideo', {courseId: course.id, videoId: video.id});
    save();
  }
  const cases = [
    {audio: 'ja', language: 'ja', question: '動画によると、インターネットで「敵対的環境コース」を検索すると、何の住所が出てきますか？', match: /企業|会社/},
    {audio: 'ja', language: 'en', question: 'According to the video, searching online for hostile environment courses will probably return whose addresses? Answer in English.', match: /compan|business|firm/i},
    {audio: 'en', language: 'en', question: 'According to the video, what determines the color of cabbage juice? Answer in English.', match: /acid|alkalin|basic|pH/i},
    {audio: 'en', language: 'ja', question: '動画によると、キャベツの汁の色は何によって変わりますか？日本語で答えてください。', match: /酸|アルカリ|塩基|pH/i},
  ];
  const results = [];
  for (const item of cases) {
    const messages = [{role: 'user', content: item.question}];
    const started = performance.now();
    const response = await rpc('chat.send', {courseId: state.courseId, messages}, false, item.language);
    const text = response.answer.segments.map(segment => segment.text).join(' ');
    assert.match(text, item.match);
    assert(response.answer.sources.some(source => source.video_id === state.videos[item.audio].id));
    const sourceIds = new Set(response.answer.sources.filter(source => source.video_id === state.videos[item.audio].id).map(source => source.id));
    assert(response.answer.segments.some(segment => segment.sourceIds.some(id => sourceIds.has(id))));
    const stream = await fetch(origin + '/api/chat/messages/stream', {method: 'POST',
      headers: {...headers, Cookie: cookie, 'Accept-Language': item.language}, body: JSON.stringify({course_id: state.courseId, messages})});
    assert.equal(stream.status, 200);
    const events = (await stream.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const streamed = events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
    assert.match(streamed, item.match);
    assert(events.some(event => event.type === 'citation'));
    assert(events.some(event => event.type === 'done'));
    assert(!events.some(event => event.type === 'error'), JSON.stringify(events));
    results.push({audioLanguage: item.audio, questionLanguage: item.language, question: item.question,
      answer: response.answer, streamedAnswer: streamed, elapsedSeconds: (performance.now() - started) / 1000});
    console.log(item.audio + ' audio → ' + item.language + ' question: cited answer and SSE passed');
  }
  writeFileSync(join(output, 'model-e2e-result.json'), JSON.stringify({status: 'passed', inference: 'real models; no protocol fixtures',
    models: ['gpt-oss-20b', 'EmbeddingGemma 2 text-only 768d', 'Whisper large-v3-turbo Q5_0'],
    courseId: state.courseId, videos: state.videos, cases: results}, null, 2) + '\n');
} finally { await closeLabHttp(); }
