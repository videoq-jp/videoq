import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { nginxHeaders } from './nginx-headers.mjs';

const source = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');

test('all shared security headers are emitted for nginx, including error responses', () => {
  const output = nginxHeaders(source);
  for (const [, name] of source.matchAll(/^[ \t]+([^:\r\n]+):[ \t]*(.+)$/gm)) {
    assert.match(output, new RegExp(`add_header ${name} ".*" always;`));
  }
  assert.match(output, /script-src 'self';/);
  assert.match(output, /frame-ancestors 'none'/);
  for (const directive of ['img', 'media', 'connect']) {
    assert.match(output, new RegExp(`${directive}-src [^;]*\\$\\{VIDEOQ_CSP_STORAGE_ORIGINS\\}`));
  }
  assert.doesNotMatch(output, /Cross-Origin-Embedder-Policy|Cross-Origin-Resource-Policy/);
});

test('an absolute API URL allows its origin for API requests and protected media', () => {
  const output = nginxHeaders(source, 'https://api.example.edu:9443/api');
  for (const directive of ['img', 'media', 'connect']) {
    assert.match(output, new RegExp(`${directive}-src [^;]*https://api\\.example\\.edu:9443 `));
  }
  assert.doesNotMatch(output, /example\.edu:9443\/api/);
  assert.throws(() => nginxHeaders(source, 'javascript:alert(1)'));
  assert.throws(() => nginxHeaders(source, 'https://user:password@example.edu/api'));
  assert.throws(() => nginxHeaders('/*\n  X-Frame-Options: DENY\n'), /must define a CSP/);
});
