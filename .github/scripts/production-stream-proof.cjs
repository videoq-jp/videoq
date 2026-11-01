// Require complete streams; course answers must also confirm persistence.
// Callers supply the reviewed SSE parser; provider content is never logged.
async function verifyStream(response, createParser, videoId) {
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    throw new Error('Streaming response unavailable');
  }
  let done = false, cited = false, bytes = 0, chatLogId;
  const texts = new Map(), sources = new Set();
  const parser = createParser({ onEvent({ data }) {
    const event = JSON.parse(data);
    if (done || event.type === 'error') throw new Error('Streaming answer failed');
    if (event.type === 'source' && event.source?.video_id === videoId && event.source.evidence_type !== 'visual') sources.add(event.source.id);
    if (event.type === 'text_delta') {
      if (!Number.isSafeInteger(event.segmentIndex) || event.segmentIndex < 0 || typeof event.text !== 'string') throw new Error('Invalid streamed text');
      texts.set(event.segmentIndex, (texts.get(event.segmentIndex) || '') + event.text);
    }
    if (event.type === 'citation' && texts.get(event.segmentIndex)?.trim() && sources.has(event.sourceId)) cited = true;
    if (event.type === 'done') {
      if (videoId === undefined ? event.chat_log_id !== null : !Number.isSafeInteger(event.chat_log_id) || event.chat_log_id <= 0) {
        throw new Error('Unexpected streaming answer persistence');
      }
      done = true; chatLogId = event.chat_log_id;
    }
  }});
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 1_000_000) throw new Error('Streaming proof exceeded its size limit');
    parser.feed(decoder.decode(chunk, { stream: true }));
  }
  parser.feed(decoder.decode());
  if (!done || ![...texts.values()].some(text => text.trim()) || (videoId !== undefined && !cited)) {
    throw new Error('Incomplete streaming answer proof');
  }
  return chatLogId;
}
module.exports = { verifyStream };
