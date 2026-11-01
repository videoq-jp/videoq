const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createParser } = createRequire(require('node:path').resolve('.github/operations-tools/package.json'))('eventsource-parser');
const { verifyStream } = require('./production-stream-proof.cjs');
const text = { type: 'text_delta', segmentIndex: 0, text: '日本語の回答' };
const done = { type: 'done', chat_log_id: 9 };
const source = { type: 'source', source: { id: 1, video_id: 42, evidence_type: 'transcript' } };
const citation = { type: 'citation', segmentIndex: 0, sourceId: 1 };
function response(events) {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    // Split every UTF-8 code point and SSE delimiter across transport chunks.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  }}), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
test('stream proof requires text, own-video transcript citations and persisted completion', async () => {
  assert.equal(await verifyStream(response([source, text, citation, done]), createParser, 42), 9);
  assert.equal(await verifyStream(response([text, {...done,chat_log_id:null}]), createParser), null);
});
test('partial, failed, unpersisted or unrelated answers cannot pass', async () => {
  for (const events of [[source,text,citation], [done], [text,{type:'error',message:'PRIVATE'}],
    [text,{...done,chat_log_id:null}], [text,done,text], [text,citation,done],
    [{...source,source:{...source.source,video_id:99}},text,citation,done]]) {
    await assert.rejects(verifyStream(response(events),createParser,42));
  }
  await assert.rejects(verifyStream(new Response('not SSE'),createParser));
});
