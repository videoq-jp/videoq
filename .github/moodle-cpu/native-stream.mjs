// Read-only Chromium wire observation. The native UI aborts its reader after
// done; Network.getResponseBody / Playwright response.text() then lose the body.
// https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent
export async function observeNativeStream(page, {url, headerTimeout = 30_000, timeout = 330_000,
  maxBytes = 8 * 1024 * 1024, maxEvents = 100_000} = {}) {
  const session = await page.context().newCDPSession(page);
  const events = [], decoder = new TextDecoder('utf-8', {fatal: true});
  const state = {status: null, contentKind: 'unknown', chunks: 0, bytes: 0, events: 0,
    done: false, error: false, cancelled: false, finished: false, incrementalText: false, observationFailed: false};
  let requestId, enabled = false, ended = false, settled = false, disposed = false, pending = [], pendingBytes = 0, text = '';
  let resolveResult, rejectResult, resolveReady, rejectReady;
  const result = new Promise((resolve, reject) => {resolveResult = resolve; rejectResult = reject;});
  const ready = new Promise((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
  // A failed click may exit before the caller reaches either await.
  result.catch(() => {}); ready.catch(() => {});
  let timer;
  function fail() {
    if (settled) return;
    settled = true; state.observationFailed = true; clearTimeout(timer);
    const error = new Error('Native stream observation failed');
    rejectReady(error); rejectResult(error);
  }
  function arm(ms) {clearTimeout(timer); timer = setTimeout(fail, ms);}
  function parse(bytes, final = false) {
    if (settled) return;
    try {
      state.bytes += bytes.length;
      if (state.bytes > maxBytes) return fail();
      const before = events.length;
      text += decoder.decode(bytes, {stream: !final});
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(text))) {
        const frame = text.slice(0, boundary.index);
        text = text.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/).filter(line => line.startsWith('data:'));
        if (!lines.length) continue;
        const event = JSON.parse(lines.map(line => line.slice(5).replace(/^ /, '')).join('\n'));
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return fail();
        if (events.length >= maxEvents) return fail();
        events.push(event);
      }
      const received = events.slice(before);
      if (!state.done && received.some(event => event.type === 'text_delta') && !received.some(event => event.type === 'done'))
        state.incrementalText = true;
      state.done ||= received.some(event => event.type === 'done');
      state.error ||= received.some(event => event.type === 'error');
      state.events = events.length;
      if (final && text.trim()) fail();
    } catch {fail();}
  }
  function complete() {
    if (!enabled || !ended || state.status === null || settled) return;
    parse(new Uint8Array(), true);
    if (settled) return;
    if (state.status !== 200 || state.contentKind !== 'sse' || (!state.done && !state.error)) return fail();
    settled = true; clearTimeout(timer); resolveResult({events, evidence: {...state}});
  }
  function headersReady() {
    if (enabled && state.status !== null && !settled) {resolveReady(); complete();}
  }
  const handlers = {
    'Network.requestWillBeSent': value => {
      if (settled) return;
      if (requestId === value.requestId && value.request.url !== url) return fail();
      if (value.request.url !== url || value.request.method !== 'POST') return;
      if (requestId) return fail();
      requestId = value.requestId;
      // Enable before response headers, including very short error streams.
      session.send('Network.streamResourceContent', {requestId}).then(value => {
        if (disposed || settled) return;
        parse(Buffer.from(value.bufferedData, 'base64'));
        for (const chunk of pending) parse(chunk);
        pending = []; pendingBytes = 0; enabled = true; headersReady();
      }, fail);
    },
    'Network.responseReceived': value => {
      if (value.requestId !== requestId || settled) return;
      state.status = Number.isInteger(value.response.status) && value.response.status >= 100 && value.response.status <= 599
        ? value.response.status : null;
      state.contentKind = value.response.mimeType?.split(';')[0].trim().toLowerCase() === 'text/event-stream' ? 'sse' : 'other';
      arm(timeout); headersReady();
    },
    'Network.dataReceived': value => {
      if (value.requestId !== requestId || settled || !value.data) return;
      state.chunks++;
      const bytes = Buffer.from(value.data, 'base64');
      if (enabled) parse(bytes);
      else {
        pending.push(bytes);
        pendingBytes += bytes.length;
        if (pendingBytes > maxBytes) fail();
      }
    },
    'Network.loadingFinished': value => {
      if (value.requestId !== requestId || settled) return;
      state.finished = true; ended = true; complete();
    },
    'Network.loadingFailed': value => {
      if (value.requestId !== requestId || settled) return;
      state.cancelled = value.canceled === true;
      if (!state.cancelled) return fail();
      ended = true; complete();
    },
  };
  for (const [name, handler] of Object.entries(handlers)) session.on(name, handler);
  try {await session.send('Network.enable');} catch {fail();}
  if (!settled) arm(headerTimeout);
  return {result, ready, snapshot: () => ({...state}), async dispose() {
    disposed = true; if (!settled) fail(); clearTimeout(timer);
    for (const [name, handler] of Object.entries(handlers)) session.off(name, handler);
    await session.detach().catch(() => {});
  }};
}

export async function captureNativeStream(page, options, send) {
  const observer = await observeNativeStream(page, options);
  try {await send(); return await observer.result;}
  finally {options.onEvidence?.(observer.snapshot()); await observer.dispose();}
}
