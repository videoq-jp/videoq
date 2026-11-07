import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';
import {captureOriginalNativeSession, installNativeReader} from './native-browser.mjs';

// Actual pinned core/ajax and jQuery with controlled gateway refusals. This
// reproduces default login navigation without a Moodle/database/model lab.
test('original Moodle session refusal survives core/ajax login navigation and cookie rotation', {timeout: 30_000}, async () => {
  assert(process.env.VIDEOQ_MOODLE_SOURCE, 'Provide the already prepared pinned Moodle source');
  let core = process.env.VIDEOQ_MOODLE_SOURCE;
  if (existsSync(join(core, 'public'))) core = join(core, 'public');
  const ajax = readFileSync(join(core, 'lib/amd/src/ajax.js'));
  const jquery = readFileSync(join(core, 'lib/jquery/jquery-3.7.1.min.js'));
  const observed = [];
  let mode = 'login';
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/jquery.js' || url.pathname === '/ajax.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(url.pathname === '/ajax.js' ? ajax : jquery); return;
    }
    if (url.pathname === '/login/index.php') {res.end('<!doctype html><title>Moodle login</title>'); return;}
    if (url.pathname === '/lib/ajax/service.php') {
      const chunks = [];
      req.on('data', value => chunks.push(value));
      req.on('end', () => {
        const rows = JSON.parse(Buffer.concat(chunks).toString('utf8')), call = rows[0];
        observed.push({operation: call.args.operation, originalCookie: req.headers.cookie === 'MoodleSession=owned-original',
          noAuthorization: !req.headers.authorization, csrf: url.searchParams.get('sesskey') === 'owned-csrf',
          method: req.method, courseid: call.args.courseid, lesson: call.args.lesson});
        res.setHeader('Set-Cookie', 'MoodleSession=owned-anonymous; Path=/; HttpOnly; SameSite=Lax');
        if (mode === 'transport') {res.writeHead(500); res.end('controlled server failure'); return;}
        if (mode === 'redirect') {res.writeHead(302, {Location: '/login/index.php'}); res.end(); return;}
        if (mode === 'html') {res.end('<!doctype html><title>Unexpected response</title>'); return;}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([{error: true, exception: {errorcode: mode === 'login' ? 'servicerequireslogin' : 'unknown',
          message: 'Controlled refusal detail'}}]));
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'MoodleSession=owned-original; Path=/; HttpOnly; SameSite=Lax');
    res.end(`<!doctype html><div class="local-videoq-workspace" data-videoq-native
      data-videoq-config='{"courseid":42,"lesson":"legacy_1"}'></div>
      <script>window.M={cfg:{sesskey:'owned-csrf'}};</script><script src="/jquery.js"></script>
      <script>window.define=(names,factory)=>{window.coreAjax=factory(jQuery,
        {wwwroot:location.origin,sesskey:M.cfg.sesskey},{debug(){},warn(){},error(){}},
        {relativeUrl:path=>location.origin+path});};</script><script src="/ajax.js"></script>
      <script>window.require=(names,callback)=>callback(coreAjax);</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless: true,
      ...(process.env.VIDEOQ_NATIVE_STREAM_BROWSER_CHANNEL ? {channel: process.env.VIDEOQ_NATIVE_STREAM_BROWSER_CHANNEL} : {})});
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await installNativeReader(context, {origin});
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    await page.goto(origin);
    const originalSession = await captureOriginalNativeSession(page, {origin});
    const oldRead = page.evaluate(() => window.__cpuRead('materials'));
    oldRead.catch(() => {});
    await page.waitForURL(origin + '/login/index.php');
    await assert.rejects(oldRead, 'Default core/ajax navigation destroys the old in-page observer');
    assert.equal((await context.cookies(origin)).find(cookie => cookie.name === 'MoodleSession')?.value, 'owned-anonymous');
    assert.equal((await originalSession('conversations', {action: 'get', conversationId: 'owned'})).status, 401);
    assert.equal((await originalSession('qa', {action: 'ask', title: 'Denied', body: 'Denied', videoId: 1})).status, 401);
    assert.deepEqual(observed.map(row => row.operation), ['materials', 'conversations', 'qa']);
    assert(observed.every(row => row.originalCookie && row.noAuthorization && row.csrf && row.method === 'POST'
      && row.courseid === 42 && row.lesson === 'legacy_1'), 'Both probes replay the original real cookie and context');
    mode = 'unknown';
    assert.equal((await originalSession('conversations', {action: 'get'})).status, 503, 'Unknown errors are not auth evidence');
    for (mode of ['transport', 'redirect', 'html'])
      await assert.rejects(originalSession('conversations', {action: 'get'}), 'Unexpected transport/HTML/redirect must fail');
    await context.close();
  } finally {await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
});
