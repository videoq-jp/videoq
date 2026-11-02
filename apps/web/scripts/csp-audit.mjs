import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

export function assertScriptPolicy(policy) {
  assert.ok(policy, 'Missing enforcing Content-Security-Policy header');
  const directives = new Map();
  for (const directive of policy.split(';').map(value => value.trim()).filter(Boolean)) {
    const [name, ...values] = directive.split(/\s+/);
    assert.ok(!directives.has(name), `Duplicate CSP directive: ${name}`);
    directives.set(name, values);
  }
  assert.deepEqual(directives.get('script-src'), ["'self'"], 'Only same-origin scripts may execute');
  for (const name of ['script-src-elem', 'script-src-attr']) {
    if (directives.has(name)) assert.deepEqual(directives.get(name), ["'none'"], `${name} must not weaken script-src`);
  }
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('base-uri'), ["'self'"]);
}

/** Probe this browser only. No test content is saved to the target application. */
export async function auditCsp(browser, url) {
  const target = new URL(url);
  const probe = new URL('/__videoq_csp_probe__.js', target).href;
  const external = 'https://videoq-xss-probe.invalid/script.js';
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    // Prevent writes and third-party traffic; synthetic scripts never reach a server.
    await context.route('**/*', async route => {
      const request = route.request();
      if (!['GET', 'HEAD'].includes(request.method())) return route.abort();
      if (request.url() === probe) return route.fulfill({ contentType: 'text/javascript', body: `
        window.__videoqCspProbe.allowed = true;
        try { new Function('window.__videoqCspProbe.eval = true')(); } catch {}
      ` });
      if (request.url() === external) return route.fulfill({ contentType: 'text/javascript', body: 'window.__videoqCspProbe.external = true;' });
      if (new URL(request.url()).origin !== target.origin) return route.abort();
      if (new URL(request.url()).pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const response = await page.goto(target.href, { waitUntil: 'load', timeout: 30_000 });
    assert.equal(response.status(), 200, 'Page must return HTML successfully');
    assert.match(response.headers()['content-type'] ?? '', /text\/html/);
    assertScriptPolicy(response.headers()['content-security-policy']);
    await page.evaluate(async ({ probe, external }) => {
      const state = window.__videoqCspProbe = { allowed: false, inline: false, event: false, external: false, eval: false, violations: [] };
      document.addEventListener('securitypolicyviolation', event => state.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
      const inline = document.createElement('script');
      inline.textContent = 'window.__videoqCspProbe.inline = true';
      document.head.append(inline);
      const button = document.createElement('button');
      button.setAttribute('onclick', 'window.__videoqCspProbe.event = true');
      document.body.append(button);
      button.click();
      button.remove();
      const loadScript = src => new Promise(resolve => {
        const script = document.createElement('script');
        script.onload = script.onerror = resolve;
        script.src = src;
        document.head.append(script);
      });
      await Promise.all([loadScript(probe), loadScript(external)]);
    }, { probe, external });
    await page.waitForFunction(() => window.__videoqCspProbe.violations.length >= 4, undefined, { timeout: 5000 });
    const result = await page.evaluate(() => window.__videoqCspProbe);
    assert.equal(result.allowed, true, 'Allowed same-origin probe must actually execute');
    for (const kind of ['inline', 'event', 'external', 'eval']) assert.equal(result[kind], false, `${kind} JavaScript executed`);
    for (const blocked of ['inline', 'eval', external]) {
      assert.ok(result.violations.some(event => event.blocked === blocked), `Missing browser rejection for ${blocked}`);
    }
    assert.ok(result.violations.some(event => event.directive === 'script-src-attr'), 'Missing event-handler rejection');
    return { url: target.href, policy: response.headers()['content-security-policy'], ...result };
  } finally { await context.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch({ channel: process.env.CI ? 'chrome' : undefined });
  try {
    for (const url of process.argv.slice(2).length ? process.argv.slice(2) : ['https://videoq.jp/', 'https://videoq.jp/share/security-check']) {
      console.log(JSON.stringify(await auditCsp(browser, url)));
    }
  } finally { await browser.close(); }
}
