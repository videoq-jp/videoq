import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {chromium} from 'playwright';
import {observeNativeStream} from './native-stream.mjs';

// Real loopback HTTP and Chromium; keep the UI's done-triggered abort intact.
// No fetch wrapper, response clone, API/model substitution or user profile.
test('live SSE observation survives the native reader abort and rejects an early abort', {timeout: 30_000}, async () => {
  let response, closed;
  const server = createServer((req, res) => {
    if (req.url === '/stream' && req.method === 'POST') {
      response = res;
      closed = new Promise(resolve => res.on('close', resolve));
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store'});
      res.write(': connected\n\n');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<button id="send">Send</button><script>
      const originalFetch = window.fetch;
      document.querySelector('#send').onclick = async () => {
        window.controller = new AbortController(); window.text = ''; window.done = false;
        try {
          const response = await fetch('/stream', {method: 'POST', signal: controller.signal});
          const reader = response.body.getReader(), decoder = new TextDecoder();
          while (true) {
            const value = await reader.read(); if (value.done) break;
            window.text += decoder.decode(value.value, {stream: true});
            if (window.text.includes('"type":"done"')) {window.done = true; break;}
          }
        } catch (error) {window.failed = error.name;}
        finally {controller.abort(); window.unchangedFetch = window.fetch === originalFetch;}
      };
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless: true,
      ...(process.env.VIDEOQ_NATIVE_STREAM_BROWSER_CHANNEL ? {channel: process.env.VIDEOQ_NATIVE_STREAM_BROWSER_CHANNEL} : {})});
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    for (const earlyAbort of [false, true]) {
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      await page.goto(origin);
      const observer = await observeNativeStream(page, {url: origin + '/stream', headerTimeout: 5000, timeout: 5000});
      try {
        const playwrightResponse = page.waitForResponse(value => value.url() === origin + '/stream');
        await page.locator('#send').click(); await observer.ready;
        const actualResponse = await playwrightResponse;
        response.write('data: {"type":"source","source":{"video_id":42}}\n\n');
        response.write('data: {"type":"text_delta","text":"住所"}\n\n');
        await page.waitForFunction(() => window.text.includes('住所'));
        if (earlyAbort) await page.evaluate(() => window.controller.abort());
        else response.write('data: {"type":"done"}\n\n');
        if (earlyAbort) await assert.rejects(observer.result, {message: 'Native stream observation failed'});
        else {
          const captured = await observer.result;
          assert.deepEqual(captured.events.map(event => event.type), ['source', 'text_delta', 'done']);
          assert.equal(captured.events[1].text, '住所');
          assert.equal(captured.evidence.incrementalText, true);
          assert.equal(captured.evidence.cancelled, true);
          await page.waitForFunction(() => window.done && window.unchangedFetch);
        }
        let closeTimer;
        try {
          await Promise.race([closed, new Promise((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error('Actual stream was not cancelled')), 5000);
          })]);
        } finally {clearTimeout(closeTimer);}
        // Cached body availability varies by Chromium; acceptance relies on
        // actual wire events and server cancellation, never this cache.
        assert.equal(actualResponse.status(), 200);
      } finally {await observer.dispose(); await page.close();}
    }
    await context.close();
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
