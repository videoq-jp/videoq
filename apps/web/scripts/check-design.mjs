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
      const context = await browser.newContext({ viewport: { width: process.env.DESIGN_WIDTH ? Number(process.env.DESIGN_WIDTH) : story.id.includes('mobile') ? 390 : 1280, height: story.id.includes('mobile') ? 844 : 900 } });
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
        // Native pointer input is required: synthetic userEvent hover does not
        // activate CSS :hover in Storybook's standalone iframe runner.
        const toggle = page.locator('.site-header-toggle');
        if (await toggle.count() && !await page.locator('dialog[open], [role="dialog"], [role="alertdialog"]').count()) {
          await toggle.hover();
          const hover = await toggle.evaluate(el => {
            const s = getComputedStyle(el);
            return { background: s.backgroundColor, decoration: s.textDecorationLine, offset: s.textUnderlineOffset, cursor: s.cursor };
          });
          if (hover.background !== 'rgb(242, 242, 242)' || hover.decoration !== 'underline' || hover.offset !== '2px' || hover.cursor !== 'pointer') {
            errors.push(`Header hover differs from digital.go.jp: ${JSON.stringify(hover)}`);
          }
          await toggle.focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          const focus = await toggle.evaluate(el => {
            const s = getComputedStyle(el);
            return { background: s.backgroundColor, outline: s.outline, offset: s.outlineOffset };
          });
          if (focus.background !== 'rgb(255, 212, 61)' || focus.outline !== 'rgb(0, 0, 0) solid 4px' || focus.offset !== '2px') {
            errors.push(`Header keyboard focus differs from digital.go.jp: ${JSON.stringify(focus)}`);
          }
          await toggle.evaluate(el => el.blur());
          await page.mouse.move(0, 0);
        }
        const primary = page.locator('.lp-button-primary').first();
        if (await primary.count()) {
          await primary.hover();
          const hover = await primary.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, decoration: getComputedStyle(el).textDecorationLine }));
          if (hover.background !== 'rgb(0, 17, 143)' || hover.decoration !== 'underline') errors.push(`Primary button hover differs: ${JSON.stringify(hover)}`);
          await page.mouse.down();
          const active = await primary.evaluate(el => getComputedStyle(el).backgroundColor);
          if (active !== 'rgb(0, 0, 96)') errors.push(`Primary button active differs: ${active}`);
          // Release away from the link to avoid navigation.
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
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
