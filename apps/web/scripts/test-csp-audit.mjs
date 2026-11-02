import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { assertScriptPolicy, auditCsp } from './csp-audit.mjs';

const headers = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
const policy = headers.match(/^\s+Content-Security-Policy: (.+)$/m)[1];

test('rejects missing or weakened script policies, including directive overrides', () => {
  assertScriptPolicy(policy);
  for (const invalid of [null, policy.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
    policy.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    `${policy}; script-src-elem *`, `${policy}; script-src-attr 'unsafe-inline'`,
    `${policy}; script-src 'unsafe-inline'`]) {
    assert.throws(() => assertScriptPolicy(invalid));
  }
});

test('Chromium enforces the shipped CSP and the audit detects a missing header', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url !== '/unprotected') response.setHeader('Content-Security-Policy', policy);
    response.end('<!doctype html><html><head></head><body>Security fixture</body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.CI ? 'chrome' : undefined });
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await auditCsp(browser, base);
    assert.equal(result.allowed, true);
    await assert.rejects(auditCsp(browser, `${base}/unprotected`), /Missing enforcing/);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
