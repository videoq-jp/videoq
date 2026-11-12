import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {observeNativeStream} from './native-stream.mjs';

const url = 'https://moodle.localhost:18443/local/videoq/stream.php';
const frame = event => Buffer.from('data: ' + JSON.stringify(event) + '\r\n\r\n');
async function fixture(options = {}, buffered = Buffer.alloc(0)) {
  const cdp = new EventEmitter();
  let enable, detached = false;
  cdp.send = async name => name === 'Network.streamResourceContent'
    ? new Promise(resolve => {enable = () => resolve({bufferedData: buffered.toString('base64')});}) : {};
  cdp.detach = async () => {detached = true;};
  const observer = await observeNativeStream({context: () => ({newCDPSession: async () => cdp})},
    {url, headerTimeout: 1000, timeout: 1000, ...options});
  const emit = (name, data = {}) => cdp.emit('Network.' + name, {requestId: 'owned', ...data});
  const data = bytes => emit('dataReceived', {data: Buffer.from(bytes).toString('base64')});
  const request = () => emit('requestWillBeSent', {request: {url, method: 'POST'}});
  const headers = () => emit('responseReceived', {response: {status: 200, mimeType: 'text/event-stream'}});
  const start = async () => {request(); headers(); enable(); await observer.ready;};
  return {observer, cdp, emit, data, request, headers, start, enable: () => enable(), detached: () => detached};
}

test('wire prefix precedes queued data, UTF-8 and CRLF survive arbitrary chunks; snapshot is private', async () => {
  const expected = [{type: 'source', source: {video_id: 42}}, {type: 'text_delta', text: '非公開住所'}, {type: 'done'}];
  const f = await fixture({}, frame(expected[0]));
  try {
    f.request(); f.headers();
    const bytes = frame(expected[1]);
    for (const byte of bytes) f.data([byte]);
    f.enable(); await f.observer.ready;
    f.data(frame(expected[2])); f.emit('loadingFailed', {canceled: true, errorText: 'private protocol detail'});
    const result = await f.observer.result;
    assert.deepEqual(result.events, expected);
    assert.equal(result.evidence.cancelled, true);
    assert.equal(result.evidence.incrementalText, true);
    assert.equal(JSON.stringify(f.observer.snapshot()).includes('非公開'), false);
    assert.equal(JSON.stringify(f.observer.snapshot()).includes('private'), false);
  } finally {await f.observer.dispose();}
  assert.equal(f.detached(), true); assert.deepEqual(f.cdp.eventNames(), []);
});

test('normal EOF works and any error following done is preserved for strict acceptance assertions', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.data(Buffer.concat([frame({type: 'done'}), frame({type: 'error', message: 'private model detail'})]));
    f.emit('loadingFinished');
    const result = await f.observer.result;
    assert.deepEqual(result.events.map(event => event.type), ['done', 'error']);
    assert.equal(result.evidence.error, true); assert.equal(result.evidence.finished, true);
  } finally {await f.observer.dispose();}
});

test('a short error stream buffered before enable completes remains an error event', async () => {
  const f = await fixture({}, frame({type: 'error', message: 'private backend response'}));
  try {
    f.request(); f.headers(); f.emit('loadingFailed', {canceled: true}); f.enable();
    const captured = await f.observer.result;
    assert.equal(captured.evidence.done, false); assert.equal(captured.evidence.error, true);
    assert.equal(captured.events[0].type, 'error');
    assert.equal(JSON.stringify(captured.evidence).includes('private'), false);
  } finally {await f.observer.dispose();}
});

test('unsupported protocol observation rejects safely and detaches its own session', async () => {
  const f = await fixture();
  try {
    f.cdp.send = async () => {throw new Error('private Chromium protocol detail');};
    f.request();
    await assert.rejects(f.observer.result, {message: 'Native stream observation failed'});
    await assert.rejects(f.observer.ready, {message: 'Native stream observation failed'});
  } finally {await f.observer.dispose();}
  assert.equal(f.detached(), true);
});

for (const [name, options, send] of [
  ['cancellation before a terminal event', {}, f => f.emit('loadingFailed', {canceled: true})],
  ['network failure even after done', {}, f => {f.data(frame({type: 'done'})); f.emit('loadingFailed', {canceled: false});}],
  ['byte bound', {maxBytes: 8}, f => f.data(frame({type: 'done'}))],
  ['event bound', {maxEvents: 1}, f => f.data(Buffer.concat([frame({type: 'done'}), frame({type: 'done'})]))],
  ['malformed JSON', {}, f => f.data('data: {private\n\n')],
  ['invalid UTF-8', {}, f => f.data([0xff])],
  ['truncated final frame', {}, f => {f.data('data: {"type":"done"}'); f.emit('loadingFinished');}],
  ['unexpected HTML', {}, f => {f.emit('responseReceived', {response: {status: 200, mimeType: 'text/html'}}); f.data(frame({type: 'done'})); f.emit('loadingFinished');}],
  ['non-200 response', {}, f => {f.emit('responseReceived', {response: {status: 403, mimeType: 'text/event-stream'}}); f.data(frame({type: 'error'})); f.emit('loadingFinished');}],
]) test(name + ' rejects with a fixed safe error', async () => {
  const f = await fixture(options);
  try {
    await f.start(); send(f);
    await assert.rejects(f.observer.result, {message: 'Native stream observation failed'});
    assert.equal(f.observer.snapshot().observationFailed, true);
  } finally {await f.observer.dispose();}
});

test('unrelated origins, query strings and GET cannot satisfy the stream observer', async () => {
  const f = await fixture({headerTimeout: 20});
  try {
    for (const request of [{url: url + '?private=x', method: 'POST'}, {url, method: 'GET'},
      {url: url.replace('moodle.localhost', 'elsewhere.localhost'), method: 'POST'}])
      f.emit('requestWillBeSent', {request});
    await assert.rejects(f.observer.result, {message: 'Native stream observation failed'});
    assert.equal(f.observer.snapshot().events, 0);
  } finally {await f.observer.dispose();}
});

test('stream completion timeout and disposal both reject without leaving handlers', async () => {
  for (const dispose of [false, true]) {
    const f = await fixture({timeout: 20});
    await f.start();
    if (dispose) await f.observer.dispose();
    await assert.rejects(f.observer.result, {message: 'Native stream observation failed'});
    await f.observer.dispose(); assert.deepEqual(f.cdp.eventNames(), []);
  }
});
