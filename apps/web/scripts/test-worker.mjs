import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { unstable_dev } from 'wrangler';
import { htmlText } from './html-text.mjs';

let worker;
before(async () => {
  worker = await unstable_dev('worker/index.ts', {
    config: 'wrangler.jsonc',
    env: 'production',
    local: true,
    ip: '127.0.0.1',
    port: 0,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true, watch: false },
  });
});
after(async () => { await worker?.stop(); });

function securityHeaders(response) {
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(response.headers.get('content-security-policy'), /https:\/\/\*\.r2\.cloudflarestorage\.com/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
}

test('rewrites Japanese and English deep links before the SPA starts', async () => {
  for (const [path, lang, canonical] of [
    ['/', 'ja', 'https://videoq.jp/'],
    ['/pricing', 'ja', 'https://videoq.jp/pricing'],
    ['/en/pricing', 'en', 'https://videoq.jp/en/pricing'],
  ]) {
    const response = await worker.fetch(path);
    assert.equal(response.status, 200);
    securityHeaders(response);
    assert.equal(response.headers.get('etag'), null);
    const html = await response.text();
    assert.match(html, new RegExp(`<html[^>]+lang="${lang}"`));
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical}"`));
    assert.match(html, /name="robots" content="index, follow"/);
    assert.match(html, /rel="alternate" hreflang="en" href="https:\/\/videoq.jp\/en/);
    if (path === '/en/pricing') {
      assert.match(html, /<title>Pricing/);
      assert.match(html, /property="og:locale" content="en_US"/);
    }
  }
});

test('public pages carry their body and metadata in the first HTML', async () => {
  for (const [path, lang, heading, title] of [
    ['/', 'ja', '受講生の質問に', /動画講座の質問対応/],
    ['/en/', 'en', 'Student questions', /Answer online course questions/],
    ['/pricing', 'ja', '料金', /料金プラン/],
    ['/guides', 'ja', '動画講座の質問対応ガイド', /動画講座の質問対応ガイド/],
    ['/guides/online-course-questions', 'ja', '動画講座の質問対応をAIで軽くする方法', /動画講座の質問対応をAIで軽くする方法/],
    ['/en/guides/how-ai-answers-work', 'en', 'How VideoQ AI answers work', /How VideoQ AI answers work/],
  ]) {
    const response = await worker.fetch(path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, new RegExp(`<html[^>]+lang="${lang}"`), path);
    assert.equal(html.match(/<title>(.*?)<\/title>/)[1].match(title) !== null, true, path);
    const [h1] = html.match(/<h1[\s\S]*?<\/h1>/) ?? [''];
    assert.ok(htmlText(h1).includes(heading), `${path}: ${h1}`);
    assert.equal(html.match(/<h1[\s>]/g).length, 1, path);
    assert.doesNotMatch(html, /<noscript>/);
    assert.doesNotMatch(html, /<script(?![^>]*(type="application\/ld\+json"|type="module"[^>]*src=))/, path);
  }
  const guide = await (await worker.fetch('/guides/online-course-questions')).text();
  assert.match(guide, /"@type":"Article"/);
  assert.match(guide, /"@type":"BreadcrumbList"/);
  assert.match(await (await worker.fetch('/')).text(), /"@type":"VideoObject"/);
});

test('application routes start from the empty shell', async () => {
  for (const path of ['/videos', '/en/settings', '/share/token']) {
    const html = await (await worker.fetch(path)).text();
    assert.match(html, /<div id="root"><\/div>/, path);
  }
});

test('unknown paths answer 404 with noindex, and the shell has no URL of its own', async () => {
  for (const path of ['/no-such-page', '/en/no-such-page', '/guides/unknown', '/en/guides/unknown', '/a/b/c', '/app-shell']) {
    const response = await worker.fetch(path);
    assert.equal(response.status, 404, path);
    securityHeaders(response);
    const html = await response.text();
    assert.match(html, /name="robots" content="noindex, nofollow"/, path);
    assert.match(html, /<title>(ページが見つかりません|Page not found)/, path);
  }
});

test('HEAD matches GET on rewritten HTML', async () => {
  for (const [path, status] of [['/', 200], ['/en/pricing', 200], ['/videos', 200], ['/no-such-page', 404]]) {
    const response = await worker.fetch(path, { method: 'HEAD' });
    assert.equal(response.status, status, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(await response.text(), '');
  }
});

test('each page has one URL', async () => {
  for (const [path, expected] of [['/en', '/en/'], ['/pricing/', '/pricing'], ['/en/guides/', '/en/guides'], ['/guides//', '/guides']]) {
    const response = await worker.fetch(path, { redirect: 'manual' });
    assert.equal(response.status, 301, path);
    assert.equal(new URL(response.headers.get('location')).pathname, expected);
  }
});

test('generated sitemap lists only pages that answer 200', async () => {
  const response = await worker.fetch('/sitemap.xml');
  assert.equal(response.status, 200);
  const urls = [...(await response.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map(match => new URL(match[1]).pathname);
  assert.ok(urls.includes('/guides/online-course-questions'));
  for (const path of urls) assert.equal((await worker.fetch(path)).status, 200, path);
});

test('retired API documentation answers 404 instead of redirecting', async () => {
  for (const path of ['/docs/videos', '/en/docs/videos', '/docs/videos?source=search', '/en/docs/videos?next=https://example.com', '/docs/plog', '/en/docs/plog', '/docs/unknown', '/docs/videos/123']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(path, { method, redirect: 'manual' });
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get('location'), null, path);
      securityHeaders(response);
      if (method === 'GET') assert.match(await response.text(), /name="robots" content="noindex, nofollow"/, path);
    }
  }
});

test('private SPA routes keep noindex metadata', async () => {
  for (const path of ['/login', '/en/login', '/videos/123', '/en/settings']) {
    const response = await worker.fetch(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /name="robots" content="noindex, nofollow"/);
  }
});

test('legacy Japanese redirects retain query strings and stay on the same origin', async () => {
  for (const [path, expected] of [
    ['/ja?source=old', '/?source=old'],
    ['/ja/pricing?source=old', '/pricing?source=old'],
    ['/ja//example.com/path', '//example.com/path'],
  ]) {
    const response = await worker.fetch(path, { redirect: 'manual' });
    assert.equal(response.status, 301);
    securityHeaders(response);
    const location = new URL(response.headers.get('location'));
    assert.notEqual(location.hostname, 'example.com');
    assert.equal(location.pathname + location.search, expected);
  }
});

test('www redirects to the canonical production host', async () => {
  // Wrangler otherwise forwards every local request to the first configured
  // route (videoq.jp), regardless of the URL passed to worker.fetch().
  const www = await unstable_dev('worker/index.ts', {
    config: 'wrangler.jsonc', env: 'production', local: true,
    host: 'www.videoq.jp', port: 0, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, watch: false },
  });
  try {
    const response = await www.fetch('/en/pricing?source=www', { redirect: 'manual' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), 'https://videoq.jp/en/pricing?source=www');
    securityHeaders(response);
  } finally {
    await www.stop();
  }
});

test('API routes cannot be served as frontend HTML', async () => {
  for (const path of ['/api', '/api/auth/get-session', '/.well-known/openid-configuration', '/health', '/ready']) {
    const response = await worker.fetch(path);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not Found');
    securityHeaders(response);
  }
});

test('landing events reach the collector instead of the SPA', async () => {
  const response = await worker.fetch('/__events/landing', {
    method: 'POST',
    headers: { Origin: 'http://videoq.jp', 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'demo_source', audience: 'school', locale: 'ja', placement: 'none' }),
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  securityHeaders(response);
  assert.equal((await worker.fetch('/__events/landing')).status, 405);
});

test('landing demos support byte-range seeking and captions', async () => {
  for (const name of ['explain-ja', 'explain-en', 'student-demo-ja', 'student-demo-en', 'provider-demo-ja', 'provider-demo-en']) {
    const bytes = await readFile(`dist/demo/${name}.mp4`);
    assert.ok(bytes.length <= 16 * 1024 * 1024);
    const response = await worker.fetch(`/demo/${name}.mp4?v=2`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-type'), /video\/mp4/);
    assert.equal(response.headers.get('content-range'), `bytes 0-99/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 100));
    securityHeaders(response);
    const middle = await worker.fetch(`/demo/${name}.mp4?v=2`, { headers: { Range: 'bytes=2048-4095' } });
    assert.equal(middle.status, 206);
    assert.deepEqual(Buffer.from(await middle.arrayBuffer()), bytes.subarray(2048, 4096));
    const captions = await worker.fetch(`/demo/${name}.vtt`);
    assert.equal(captions.status, 200);
    assert.match(captions.headers.get('content-type'), /text\/vtt/);
    assert.match(await captions.text(), /^WEBVTT/);
    const poster = await worker.fetch(`/demo/${name}-poster.webp?v=2`);
    assert.equal(poster.status, 200);
    assert.match(poster.headers.get('content-type'), /image\/webp/);
    assert.deepEqual(Buffer.from(await poster.arrayBuffer()), await readFile(`dist/demo/${name}-poster.webp`));
  }
});

test('provider demo suffix ranges and invalid seeks follow HTTP range semantics', async () => {
  const path = '/demo/provider-demo-ja.mp4';
  const head = await worker.fetch(path, { method: 'HEAD' });
  const size = (await stat('dist/demo/provider-demo-ja.mp4')).size;
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.match(head.headers.get('content-type'), /video\/mp4/);
  assert.ok(size > 100 && size <= 16 * 1024 * 1024);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const suffix = await worker.fetch(path, { headers: { Range: 'bytes=-100' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes ${size - 100}-${size - 1}/${size}`);
  assert.equal((await suffix.arrayBuffer()).byteLength, 100);
  const invalid = await worker.fetch(path, { headers: { Range: `bytes=${size}-` } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${size}`);
});

test('static files and hashed JavaScript retain content types and security headers', async () => {
  const response = await worker.fetch('/');
  const html = await response.text();
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, 'Vite entry script must exist');
  for (const [path, type] of [[asset, /javascript/], ['/robots.txt', /text\/plain/], ['/sitemap.xml', /xml/]]) {
    const result = await worker.fetch(path);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), type);
    securityHeaders(result);
    assert.doesNotMatch(await result.text(), /<!doctype html>/i);
  }
});

test('local development is marked noindex and has no production API access', async () => {
  const preview = await unstable_dev('worker/index.ts', {
    config: 'wrangler.jsonc', local: true,
    ip: '127.0.0.1', port: 0, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, watch: false },
  });
  try {
    const response = await preview.fetch('/en/pricing');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(await response.text(), /name="robots" content="noindex, nofollow"/);
    assert.equal((await preview.fetch('/api/auth/get-session')).status, 404);
  } finally {
    await preview.stop();
  }
});

// Requires a browser only when explicitly enabled by the frontend build job.
// Exercise the emitted assets: DOM-only unit tests cannot catch orphaned SSR nodes.
test('saved language redirects hydrate one complete pricing page', {
  skip: process.env.VERIFY_PRERENDER_HYDRATION !== 'true',
}, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: process.env.CI ? 'chrome' : undefined });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.name));
    page.on('console', message => {
      if (message.type() === 'error' && /hydration|Minified React error/i.test(message.text())) errors.push('hydration');
    });
    await page.route('**/api/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') return route.fulfill({ status: 204 });
      const body = url.pathname.includes('/auth/') ? 'null'
        : JSON.stringify(url.pathname.split('/trpc/').at(-1).split(',').map(() => ({ result: { data: [] } })));
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    await page.addInitScript(() => localStorage.setItem('videoq.locale', 'en'));
    await page.goto(`http://${worker.address}:${worker.port}/pricing`, { waitUntil: 'networkidle' });
    await page.waitForURL('**/en/pricing');
    await page.waitForFunction(() => document.querySelectorAll('h1').length === 1 && document.querySelector('h1').textContent === 'Pricing');
    assert.equal(await page.locator('h1').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
