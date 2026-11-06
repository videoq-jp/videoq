import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { questionView } from '../src/features/lti/view';
import { courseTagInput } from '../src/features/lti/course-tags';

const browserTests = process.env.LTI_BROWSER_TESTS === '1' ? describe : describe.skip;
const id = '11111111-1111-4111-8111-111111111111';
browserTests('course tags in the existing private LTI frame', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LTI_CHROMIUM_EXECUTABLE_PATH }); });
  afterAll(async () => { await browser?.close(); });
  async function fixture(page: Page, manage = true) {
    page.setDefaultTimeout(7000);
    const errors: string[] = [], writes: unknown[] = [], receipts = new Set<string>();
    const model = { permitted: true, loseResponse: false, conflicts: false, manage,
      tags: [{ id,name: '<img src=x onerror=alert(1)>',color: 'blue',revision: crypto.randomUUID(),videoIds: [1] }] };
    const videos = [{ videoId: 1,lesson: 'first',title: '<script>Ready lesson</script>' }];
    const catalog = () => ({ tags: model.tags.map(tag => ({ ...tag,editable: manage })),canManage: manage,reused: false,
      videos: (manage ? [1,2] : [1]).map(videoId => ({ videoId,tagIds: model.tags.filter(t => t.videoIds.includes(videoId)).map(t => t.id),editable: manage,revision: 'a'.repeat(64) })) });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (location.origin === 'https://api.example') sessionStorage.setItem('videoq-lti:'+'a'.repeat(64), 'browser-secret'); });
    await page.route('https://api.example/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/lti/launch') { await route.fulfill({ contentType: 'text/html',body: questionView('nonce','a'.repeat(64),'signed-token','en',['https://lms.example']) }); return; }
      if (path === '/api/lti/session') { await route.fulfill({ json: { token: 'private-tag-token',features: { tags: true,transcripts: true },playback: { videoId: 1,parentOrigins: ['https://lms.example'],videos } } }); return; }
      expect(request.headers().authorization).toBe('Bearer private-tag-token');
      expect(request.headers().cookie).toBeUndefined();
      if (path === '/api/lti/history') { await route.fulfill({ json: { turns: [] } }); return; }
      if (!model.permitted) { await route.fulfill({ status: 403,json: { error: {} } }); return; }
      if (path === '/api/lti/materials') { await route.fulfill({ json: { permissions: { manageContent: manage,viewTranscript: true },videos,
        managementVideos: manage ? [...videos,{ videoId: 2,title: 'Pending lesson',management: { generation: 1 } }] : [] } }); return; }
      if (path === '/api/lti/transcript') { await route.fulfill({ json: { videoId: 1,title: videos[0].title,cues: [{ startTime: '00:00:00',text: '<b>literal transcript</b>' }],nextCursor: null } }); return; }
      expect(path).toBe('/api/lti/tags');
      const input = courseTagInput.parse(request.postDataJSON());
      if (input.action !== 'list') {
        writes.push(input);
        if (model.conflicts) { await route.fulfill({ status: 409,json: { error: {} } }); return; }
        if (!receipts.has(input.operationId)) {
          receipts.add(input.operationId);
          if (input.action === 'create') model.tags.push({ id: input.operationId,name: input.name,color: input.color,revision: crypto.randomUUID(),videoIds: [] });
          else if (input.action === 'delete') model.tags = model.tags.filter(t => t.id !== input.id);
          else if (input.action === 'update') Object.assign(model.tags.find(t => t.id === input.id)!,{ name: input.name,color: input.color,revision: crypto.randomUUID() });
          else for (const tag of model.tags) tag.videoIds = [...tag.videoIds.filter(videoId => videoId !== input.videoId),...(input.tagIds.includes(tag.id) ? [input.videoId] : [])];
          if (model.loseResponse) { model.loseResponse = false; await route.fulfill({ status: 503,json: { error: {} } }); return; }
        }
      }
      await route.fulfill({ json: catalog() });
    });
    return { model,writes,receipts,errors };
  }
  it('filters ready/pending materials, treats untrusted text literally and reads the selected transcript', async () => {
    const page = await browser.newPage(), service = await fixture(page);
    await page.goto('https://api.example/api/lti/launch');
    const panel = page.locator('#course-tags'); await panel.locator('summary').click();
    await expect.poll(() => page.locator('#tags-materials>li').count()).toBe(2);
    expect(await panel.locator('img,script').count()).toBe(0);
    await page.locator('#tags-filter').selectOption(id); expect(await page.locator('#tags-materials>li').count()).toBe(1);
    await page.locator('#tags-filter').selectOption('untagged'); expect(await page.locator('#tags-materials').textContent()).toContain('Pending lesson');
    await page.locator('#tags-filter').selectOption(''); await page.locator('#tags-search').fill('Ready');
    await panel.getByRole('button',{ name: 'Read transcript',exact: true }).first().click();
    await page.locator('#tags-transcript').getByText('<b>literal transcript</b>',{ exact: false }).waitFor();
    expect(await page.locator('#tags-transcript b').count()).toBe(0);
    expect(await page.locator('.course-tag-chip[data-color=blue]').count()).toBeGreaterThan(0);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.LTI_BROWSER_ARTIFACT_DIR)await page.screenshot({path:join(process.env.LTI_BROWSER_ARTIFACT_DIR,'course-tags-mobile.png'),fullPage:true});
    expect(service.errors).toEqual([]); await page.close();
  });
  it('retains conflicted drafts, replays a lost response with one operation ID, assigns tags and confirms deletion', async () => {
    const page = await browser.newPage(), service = await fixture(page);
    await page.goto('https://api.example/api/lti/launch'); const panel = page.locator('#course-tags'); await panel.locator('summary').click();
    await panel.getByRole('button',{ name: 'Create tag',exact: true }).click(); await page.locator('#tags-name').fill('My tag');
    service.model.loseResponse = true; await page.locator('#tags-save').click();
    await page.locator('#tags-status').getByText('Your draft is preserved.',{ exact: false }).waitFor();
    expect(await page.locator('#tags-name').inputValue()).toBe('My tag');
    await page.locator('#tags-save').click(); await page.locator('#tags-status').getByText('Tags saved.',{ exact: true }).waitFor();
    expect(service.writes[0]).toEqual(service.writes[1]); expect(service.receipts.size).toBe(1);
    const card = page.locator('#tags-vocabulary>li').filter({ hasText: 'My tag' }); await card.getByRole('button',{ name: 'Edit tag',exact: true }).click();
    await page.locator('#tags-name').fill('Conflicted draft'); service.model.conflicts = true; await page.locator('#tags-save').click();
    await page.locator('#tags-status').getByText('Tags changed.',{ exact: false }).waitFor(); expect(await page.locator('#tags-name').inputValue()).toBe('Conflicted draft');
    await page.locator('#tags-refresh').click(); await page.getByRole('dialog').getByRole('button',{ name: 'Cancel',exact: true }).click();
    expect(await page.locator('#tags-name').inputValue()).toBe('Conflicted draft');
    service.model.conflicts = false; await page.locator('#tags-save').click(); await page.locator('#tags-status').getByText('Tags saved.',{ exact: true }).waitFor();
    await page.locator('#tags-materials>li').filter({ hasText: 'Pending lesson' }).getByRole('button',{ name: 'Edit material tags',exact: true }).click();
    await page.locator('#tags-fields label').filter({ hasText: 'Conflicted draft' }).locator('input').check(); await page.locator('#tags-save').click();
    await page.locator('#tags-status').getByText('Tags saved.',{ exact: true }).waitFor();
    expect(service.model.tags.find(t => t.name === 'Conflicted draft')?.videoIds).toEqual([2]);
    await page.locator('#tags-vocabulary>li').filter({ hasText: 'Conflicted draft' }).getByRole('button',{ name: 'Edit tag',exact: true }).click();
    await page.locator('#tags-delete').click(); await page.getByRole('dialog').getByRole('button',{ name: 'Cancel',exact: true }).click();
    expect(service.model.tags).toHaveLength(2); await page.locator('#tags-delete').click();
    await page.getByRole('dialog').getByRole('button',{ name: 'Delete tag',exact: true }).click(); await page.locator('#tags-status').getByText('Tags saved.',{ exact: true }).waitFor();
    expect(service.model.tags).toHaveLength(1); expect(service.errors).toEqual([]); await page.close();
  },20000);
  it('keeps a revoked draft selectable but read only and never offers mutations to learners', async () => {
    const page = await browser.newPage(), service = await fixture(page);
    await page.goto('https://api.example/api/lti/launch'); await page.locator('#course-tags summary').click();
    await page.locator('#tags-create').click(); await page.locator('#tags-name').fill('Preserved after revocation');
    service.model.permitted = false; await page.locator('#tags-save').click();
    await page.locator('#tags-status').getByText('Your draft is preserved.',{ exact: false }).waitFor();
    expect(await page.locator('#tags-name').inputValue()).toBe('Preserved after revocation'); expect(await page.locator('#tags-name').getAttribute('readonly')).not.toBeNull();
    expect(await page.locator('#tags-name').isDisabled()).toBe(false); expect(await page.locator('#tags-save').isDisabled()).toBe(true);
    expect(service.model.tags).toHaveLength(1); await page.close();
    const learner = await browser.newPage(); const readOnly = await fixture(learner,false);
    await learner.goto('https://api.example/api/lti/launch'); await learner.locator('#course-tags summary').click();
    await learner.locator('#tags-materials>li').first().waitFor(); expect(await learner.locator('#tags-create').isVisible()).toBe(false);
    expect(await learner.getByRole('button',{ name: 'Edit tag',exact: true }).count()).toBe(0);
    expect(await learner.getByRole('button',{ name: 'Edit material tags',exact: true }).count()).toBe(0); expect(readOnly.writes).toEqual([]); await learner.close();
  });
  it.skipIf(!process.env.LTI_MOODLE_PLUGIN_ROOT)('opens through the native companion bridge without sending tag content or credentials to Moodle, including mobile', async () => {
    const page = await browser.newPage(); const service = await fixture(page);
    const companion = process.env.LTI_MOODLE_PLUGIN_ROOT;
    if (!companion) throw new Error('LTI_MOODLE_PLUGIN_ROOT required for the native bridge test');
    const [nativeScript,chatScript,css,template] = await Promise.all(['tags.js','chat.js','styles.css','templates/tags.mustache'].map(name=>readFile(join(companion,'plugins/local/videoq',name),'utf8')));
    const markup=template.replace(/\{\{![\s\S]*?\}\}/g,'').replaceAll('{{heading}}','Course tags').replaceAll('{{unavailable}}','Unavailable');
    await page.route('https://lms.example/**', async route => route.fulfill({ contentType: 'text/html',body: `<!doctype html><html lang="en"><style>${css}.local-videoq-questions{height:650px}</style><div class="local-videoq-workspace" data-videoq-origin="https://api.example"><section class="local-videoq-questions">${markup}<div id="videoq-native-chat"><div role="log"><p id="videoq-native-empty">Ask a question</p></div><p role="status"></p><fieldset disabled><form><textarea data-region="send-message-txt"></textarea><button data-action="send-message"><span data-region="send-icon-container">Send</span><span data-region="loading-icon-container" class="hidden">Loading</span></button></form></fieldset></div><iframe id="videoq-questions" class="local-videoq-transport" aria-hidden="true" tabindex="-1" title="Questions" src="https://api.example/api/lti/launch"></iframe></section></div><script>window.bridgeMessages=[];window.addEventListener('message',event=>{if(event.origin==='https://api.example')bridgeMessages.push(event.data)});</script><script>${chatScript}</script><script>${nativeScript}</script>` }));
    await page.setViewportSize({ width: 390,height: 844 }); await page.goto('https://lms.example/course');
    await page.locator('#videoq-course-tags summary').click(); const frame = page.frameLocator('#videoq-questions');
    await frame.locator('#course-tags').waitFor(); await frame.locator('#tags-materials>li').first().waitFor();
    expect(await frame.locator('body').getAttribute('class')).toContain('moodle-tags');
    if(process.env.LTI_BROWSER_ARTIFACT_DIR)await page.screenshot({path:join(process.env.LTI_BROWSER_ARTIFACT_DIR,'course-tags-native-mobile.png'),fullPage:true});
    const bridge = await page.evaluate(() => (window as unknown as { bridgeMessages: unknown[] }).bridgeMessages);
    expect(JSON.stringify(bridge)).not.toMatch(/private-tag-token|onerror|videoIds|operationId/);
    expect(await frame.locator('body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await frame.locator('#tags-close').click(); await expect.poll(() => frame.locator('body').getAttribute('class')).not.toContain('moodle-tags');
    expect(service.errors).toEqual([]); await page.close();
  },20000);
});
