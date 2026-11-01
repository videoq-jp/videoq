// Exercise the real image and entrypoint, not a separate test nginx config.
// Run after docker build: node apps/web/scripts/test-nginx.mjs <web-image>
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const docker = process.env.DOCKER_BIN || 'docker';
const image = process.argv[2];
assert.ok(image, 'Provide the built web image');
const command = (...args) => execFileSync(docker, args, { encoding: 'utf8' }).trim();

function security(response, path, origins) {
  assert.equal(response.headers.get('server'), 'nginx', path);
  assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()', path);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', path);
  assert.equal(response.headers.get('cross-origin-embedder-policy'), null, path);
  assert.equal(response.headers.get('cross-origin-resource-policy'), null, path);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-ancestors 'none';/);
  assert.match(csp, /frame-src https:\/\/www.youtube.com;/);
  assert.doesNotMatch(csp, /\$|undefined|\r|\n/);
  for (const directive of ['img', 'media', 'connect']) {
    const value = csp.split(';').find(part => part.trim().startsWith(`${directive}-src `));
    for (const origin of origins) assert.ok(value.includes(origin), `${path}: ${directive} permits ${origin}`);
  }
}

for (const origins of [[], ['http://127.0.0.1:19000', 'https://s3.example.edu:9443']]) {
  const id = command('run', '-d', '-p', '127.0.0.1::80', '-e', `VIDEOQ_CSP_STORAGE_ORIGINS=${origins.join(' ')}`, image);
  try {
    const address = command('port', id, '80/tcp');
    const base = `http://${address}`;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { ready = (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* entrypoint starting */ }
      if (ready) break;
      await delay(100);
    }
    if (!ready) assert.fail(command('logs', id));
    const root = await fetch(base);
    const html = await root.text();
    const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
    assert.ok(asset, 'Built HTML references a JavaScript asset');
    for (const [path, method, status] of [['/', 'GET', 200], ['/en/login', 'GET', 200],
      ['/en/videos/courses/123', 'HEAD', 200], [asset, 'GET', 200],
      ['/assets/nonexistent-security-test.js', 'GET', 404], ['/robots.txt', 'GET', 200]]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, status, path);
      security(response, path, origins);
      if (path === asset) assert.match(response.headers.get('cache-control'), /max-age=31536000.*immutable/);
      if (path === '/') assert.equal(response.headers.get('cache-control'), 'no-cache');
      if (status === 404) assert.doesNotMatch(response.headers.get('cache-control') || '', /immutable/);
      await response.body?.cancel();
    }
    const original = await fetch(base + asset);
    const etag = original.headers.get('etag');
    assert.ok(etag);
    await original.body?.cancel();
    const cached = await fetch(base + asset, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
    security(cached, '304 asset', origins);
    console.log(`nginx headers, SPA, assets, HEAD, 304 and 404 passed (${origins.length} extra storage origins)`);
  } finally {
    command('rm', '-f', id);
  }
}
for (const value of ['https://s3.example.edu/path', 'https://s3.example.edu; add_header Bad yes;', '*', 'data:']) {
  const invalid = spawnSync(docker, ['run', '--rm', '-e', `VIDEOQ_CSP_STORAGE_ORIGINS=${value}`, image, 'nginx', '-t'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0, `Invalid storage origin must fail startup: ${value}`);
  assert.match(invalid.stderr, /VIDEOQ_CSP_STORAGE_ORIGINS/);
}
console.log('Invalid CSP storage origins rejected before nginx startup.');
