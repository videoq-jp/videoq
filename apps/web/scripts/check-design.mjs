// Run against `npm run storybook`. Uses only isolated fixture data, no live API.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const base = process.env.DESIGN_PREVIEW_URL ?? 'http://127.0.0.1:6006';
const output = process.env.DESIGN_OUTPUT_DIR ?? join(tmpdir(), 'videoq-design-review');
await mkdir(output, { recursive: true });
const index = await (await fetch(`${base}/index.json`)).json();
const catalog = Object.values(index.entries).filter(s => s.type === 'story' && s.title === 'Application/Design coverage');
if (catalog.length < 90) throw new Error('Full design coverage catalog is missing');
const stories = process.env.DESIGN_FILTER ? catalog.filter(s => s.id.includes(process.env.DESIGN_FILTER)) : catalog;
const browser = await chromium.launch({ headless: true });
const results = [];
let next = 0;
try {
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < stories.length) {
      const story = stories[next++];
      const context = await browser.newContext({ viewport: { width: story.id.includes('mobile') ? 390 : 1280, height: story.id.includes('mobile') ? 844 : 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        await page.goto(`${base}/iframe.html?id=${story.id}&viewMode=story`);
        await page.waitForFunction(() => ['finished', 'errored'].includes(window.__STORYBOOK_PREVIEW__?.currentRender?.phase), undefined, { timeout: 30000 });
        const metrics = await page.evaluate(() => {
          const root = document.querySelector('#storybook-root');
          const title = root?.querySelector('main h1');
          return { phase: window.__STORYBOOK_PREVIEW__.currentRender.phase, title: title?.textContent, font: title && getComputedStyle(title).fontSize,
            width: innerWidth, scrollWidth: document.documentElement.scrollWidth, contentLength: root?.textContent.length };
        });
        if (metrics.phase !== 'finished') errors.push(`Render phase: ${metrics.phase}`);
        if (metrics.scrollWidth > metrics.width) errors.push(`Horizontal overflow: ${metrics.scrollWidth} > ${metrics.width}`);
        await page.screenshot({ path: join(output, `${story.id}.png`), fullPage: true });
        results.push({ id: story.id, ...metrics, errors });
      } catch (error) { results.push({ id: story.id, errors: [...errors, error.message] }); }
      await context.close();
      if (results.length % 10 === 0) console.log(`Reviewed ${results.length}/${stories.length}`);
    }
  }));
} finally { await browser.close(); }
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter(result => result.errors.length);
console.log(JSON.stringify({ reviewed: results.length, failed: failed.length, output }));
for (const result of failed) console.log(result.id, result.errors.join('\n'));
if (failed.length) process.exitCode = 1;
