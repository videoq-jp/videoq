import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { questionView } from '../src/features/lti/view';
import { courseReportInput } from '../src/features/lti/course-reports';

const tests = process.env.LTI_BROWSER_TESTS === '1' ? describe : describe.skip;
tests('Moodle aggregate report UI and native transport', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LTI_CHROMIUM_EXECUTABLE_PATH }); });
  afterAll(async () => { await browser?.close(); });
  async function fixture(page: Page, permitted = true, supported = true) {
    const state = 'a'.repeat(64), requests: { path: string; body: unknown }[] = [], errors: string[] = [];
    const model = { permitted, supported, denied: false, malformed: false };
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (location.origin === 'https://api.example') sessionStorage.setItem('videoq-lti:' + 'a'.repeat(64), 'fixture-browser-secret'); });
    await page.route('https://api.example/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/lti/launch') { await route.fulfill({ contentType: 'text/html', body: questionView('nonce', state, 'fixture-signed-token', 'en', ['https://lms.example']) }); return; }
      requests.push({ path, body: request.postData() ? request.postDataJSON() : {} });
      if (path === '/api/lti/session') { await route.fulfill({ json: { token: 'fixture-private-report-token', learningAvailable: false,
        features: { reports: model.supported }, playback: { videoId: 1, videos: [], parentOrigins: ['https://lms.example'] } } }); return; }
      expect(request.headers().authorization).toBe('Bearer fixture-private-report-token');
      if (path === '/api/lti/materials') { await route.fulfill({ json: { permissions: { viewReports: model.permitted }, videos: [] } }); return; }
      expect(path).toBe('/api/lti/reports');
      if (model.denied) { await route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }); return; }
      const input = courseReportInput.parse(request.postDataJSON());
      await route.fulfill({ json: { period: { from: input.from, to: input.to, timezone: 'UTC' },
        totals: { questions: 3, good: 1, bad: 1, none: 1 }, coverage: 'verified-moodle-resource-scope',
        days: [{ date: model.malformed ? '<img src=x onerror=alert(1)>' : input.from, questions: 3, good: 1, bad: 1, none: 1 }],
        ignoredPrivateText: 'PRIVATE question body must never render' } });
    });
    return { model, requests, errors };
  }
  it('loads bounded date counts and exports only aggregate CSV after a fresh permission check', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), service = await fixture(page);
    await page.goto('https://api.example/api/lti/launch');
    await page.locator('#course-reports summary').click(); await page.locator('#reports-content dd').first().waitFor();
    await page.locator('#reports-from').fill('2026-11-01'); await page.locator('#reports-to').fill('2026-11-02');
    await page.locator('#reports-form button[type=submit]').click();
    await page.locator('#reports-content tbody td').first().filter({ hasText: '2026-11-01' }).waitFor();
    expect(await page.locator('#reports-content dd').allTextContents()).toEqual(['3', '1', '1', '1']);
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE');
    const before = service.requests.filter(r => r.path === '/api/lti/reports').length;
    const download = page.waitForEvent('download'); await page.locator('#reports-export').click(); const file = await download;
    expect(service.requests.filter(r => r.path === '/api/lti/reports')).toHaveLength(before + 1);
    expect(await readFile(await file.path(), 'utf8')).toBe('date,questions,good,bad,unrated\n2026-11-01,3,1,1,1\n');
    expect(file.suggestedFilename()).toBe('videoq-usage-2026-11-01_2026-11-02.csv');
    expect(await page.locator('body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (process.env.LTI_BROWSER_ARTIFACT_DIR) await page.screenshot({ path: join(process.env.LTI_BROWSER_ARTIFACT_DIR, 'reports-teacher-mobile.png'), fullPage: true });
    expect(service.errors).toEqual([]); await page.close();
  });
  it('clears previous counts on revocation and on malformed responses without rendering provider content', async () => {
    const page = await browser.newPage(), service = await fixture(page);
    await page.goto('https://api.example/api/lti/launch'); await page.locator('#course-reports summary').click();
    await page.locator('#reports-content dd').first().waitFor(); service.model.malformed = true;
    await page.locator('#reports-form button[type=submit]').click();
    await page.locator('#reports-status').filter({ hasText: 'The report is unavailable.' }).waitFor();
    expect(await page.locator('#reports-content').innerText()).toBe(''); expect(await page.locator('#reports-content img').count()).toBe(0);
    service.model.malformed = false; await page.locator('#reports-form button[type=submit]').click(); await page.locator('#reports-content dd').first().waitFor();
    service.model.denied = true; await page.locator('#reports-form button[type=submit]').click(); await page.locator('#course-reports').waitFor({ state: 'hidden' });
    expect(await page.locator('#reports-content').innerText()).toBe(''); expect(service.errors).toEqual([]); await page.close();
  });
  it.each([{ permitted: false, supported: true }, { permitted: true, supported: false }])('hides unavailable reports without querying the aggregate endpoint: %j', async options => {
    const page = await browser.newPage(), service = await fixture(page, options.permitted, options.supported);
    await page.goto('https://api.example/api/lti/launch');
    await page.locator('#status[data-kind=waiting]').waitFor();
    expect(await page.locator('#course-reports').isHidden()).toBe(true);
    expect(service.requests.some(r => r.path === '/api/lti/reports')).toBe(false); expect(service.errors).toEqual([]); await page.close();
  });
  it.skipIf(!process.env.LTI_MOODLE_PLUGIN_PATH)('uses the actual native module and template with one private frame and no report data or credential bridge', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), service = await fixture(page);
    const root = process.env.LTI_MOODLE_PLUGIN_PATH!;
    const [script, template, css] = await Promise.all([readFile(join(root, 'reports.js'), 'utf8'), readFile(join(root, 'templates/reports.mustache'), 'utf8'), readFile(join(root, 'styles.css'), 'utf8')]);
    const markup = template.replace(/{{![\s\S]*?}}/g, '').replaceAll('{{heading}}', 'AI question usage').replaceAll('{{unavailable}}', 'Reports unavailable');
    await page.route('https://lms.example/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}.local-videoq-questions{height:750px}</style><div class="local-videoq-workspace" data-videoq-origin="https://api.example"><section class="local-videoq-questions">${markup}<textarea id="videoq-native-question"></textarea><iframe id="videoq-questions" title="Questions" src="https://api.example/api/lti/launch"></iframe></section></div>
<script>window.events=[];window.addEventListener('message',event=>{if(event.origin!=='https://api.example')return;window.events.push(event.data);if(event.data.type==='videoq:ready'){const frame=document.getElementById('videoq-questions');frame.contentWindow.postMessage({type:'videoq:ui',version:1,renderer:'moodle',channel:event.data.channel,videoId:event.data.videoId},'https://api.example');}});${script}</script></html>` }));
    await page.goto('https://lms.example/course'); const frame = page.frameLocator('#videoq-questions');
    await page.locator('#videoq-course-reports').waitFor({ state: 'visible' });
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#videoq-questions')!.contentWindow!.postMessage({ type: 'videoq:reports-ui', version: 1, channel: 'f'.repeat(32), videoId: 1, open: true }, 'https://api.example'));
    expect((await frame.locator('body').getAttribute('class')) ?? '').not.toContain('moodle-reports');
    await page.locator('#videoq-course-reports summary').click(); await frame.locator('#reports-content dd').first().waitFor();
    expect(service.requests.filter(r => r.path === '/api/lti/session')).toHaveLength(1);
    expect(await page.locator('#videoq-questions').getAttribute('src')).toBe('https://api.example/api/lti/launch');
    const bridge = await page.evaluate(() => JSON.stringify(Reflect.get(window, 'events')));
    expect(bridge).not.toMatch(/fixture-private-report-token|PRIVATE|totals|questions.*3|resourceCount/);
    service.model.permitted = false; await frame.locator('#reports-form button[type=submit]').click();
    await page.locator('#videoq-course-reports [role=status]').filter({ hasText: 'Reports unavailable' }).waitFor();
    expect(await frame.locator('#reports-content').innerText()).toBe(''); expect(service.errors).toEqual([]); await page.close();
  });
});
