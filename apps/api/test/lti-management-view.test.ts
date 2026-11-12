import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { questionView, scriptJson } from '../src/features/lti/view';
import { materialManagementInput } from '../src/features/lti/material-management';
import { validateTranscriptSrt } from '../src/lib/srt';

const browserTests = process.env.LTI_BROWSER_TESTS === '1' ? describe : describe.skip;
const state = 'a'.repeat(64);
const srt = '1\n00:00:00,000 --> 00:00:01,000\nOriginal lesson\n';
browserTests('teacher material editing in the private LTI view', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LTI_CHROMIUM_EXECUTABLE_PATH }); });
  afterAll(async () => { await browser?.close(); });

  // HTTP/processing fixtures exercise actual UI scripts, independently of the
  // real PostgreSQL authorization/transaction and worker persistence suites.
  async function fixture(page: Page, initialStatus = 'completed') {
    page.setDefaultTimeout(7000);
    const errors: string[] = [], requests: { path: string; body: Record<string, unknown> }[] = [];
    const model = { status: initialStatus, description: '<img src=x onerror=alert(1)>', transcript: srt, version: 1,
      permitted: true, loseResponse: false, conflicts: false, learningHold: false, mutations: 0 };
    const operations = new Set<string>();
    const revision = () => model.version.toString(16).padStart(64, '0');
    const material = () => ({ videoId: 1, title: '<script>untrusted title</script>', description: model.description,
      transcript: model.transcript, status: model.status, revision: revision(), canEdit: ['completed', 'error'].includes(model.status),
      canReindex: model.status === 'completed', canRetry: ['indexing', 'error'].includes(model.status), jobState: model.status === 'completed' ? 'completed' : 'queued' });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { if (location.origin === 'https://api.example') sessionStorage.setItem('videoq-lti:'+'a'.repeat(64), 'browser-secret'); });
    await page.route('https://api.example/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/lti/launch') { await route.fulfill({ contentType: 'text/html', body: questionView('nonce', state, 'signed-token', 'en', ['https://lms.example']) }); return; }
      if (path === '/api/lti/session') { requests.push({ path, body: {} }); await route.fulfill({ json: {
        token: 'private-management-token', learningAvailable: initialStatus === 'completed', features: { management: true, qa: true, conversations: true },
        playback: { videoId: 1, parentOrigins: ['https://lms.example'], videos: initialStatus === 'completed' ? [{ videoId: 1, lesson: 'first', title: 'Lesson' }] : [] },
      } }); return; }
      expect(request.headers().authorization).toBe('Bearer private-management-token');
      const body = request.postData() ? z.record(z.string(), z.unknown()).parse(request.postDataJSON()) : {};
      requests.push({ path, body });
      if (path === '/api/lti/history') { await route.fulfill({ json: { turns: [] } }); return; }
      if (path === '/api/lti/materials') { await route.fulfill({ json: {
        permissions: { manageContent: model.permitted, viewQa: true, manageOwnHistory: true },
        videos: model.status === 'completed'&&!model.learningHold ? [{ videoId: 1, lesson: 'first', title: 'Lesson' }] : [],
        managementVideos: model.permitted ? [{ videoId: 1, lesson: 'first', title: material().title, management: { generation: 1 } }] : [],
      } }); return; }
      if (path === '/api/lti/conversations') { await route.fulfill({ json: { items: [], hasMore: false } }); return; }
      if (path === '/api/lti/qa') { await route.fulfill({ json: { data: { items: [], total: 0, canPost: false, canVote: false, canModerate: false }, permissions: { viewQa: true }, videos: [] } }); return; }
      if (path === '/api/lti/messages/stream') { await route.fulfill({ json: { answer: { segments: [{ text: 'Ready answer', sourceIds: [] }], sources: [] } } }); return; }
      expect(path).toBe('/api/lti/management');
      if (!model.permitted) { await route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }); return; }
      const input = materialManagementInput.parse(body);
      if (input.action === 'get') { await route.fulfill({ json: { material: material() } }); return; }
      if(input.action==='update'&&input.fields.transcript!==undefined&&validateTranscriptSrt(input.fields.transcript)) {
        await route.fulfill({status:400,json:{error:{code:'VALIDATION_ERROR'}}});return;
      }
      if (!operations.has(input.operationId)) {
        if (model.conflicts || input.revision !== revision()) { await route.fulfill({ status: 409, json: { error: { code: 'CONFLICT' } } }); return; }
        operations.add(input.operationId); model.mutations++; model.version++;
        if (input.action === 'update') {
          if (input.fields.description !== undefined) model.description = input.fields.description;
          if (input.fields.transcript !== undefined && input.fields.transcript !== model.transcript) { model.transcript = input.fields.transcript; model.status = 'indexing'; }
        } else model.status = 'indexing';
        if (model.loseResponse) { model.loseResponse = false; await route.fulfill({ status: 503, json: { error: {} } }); return; }
      }
      await route.fulfill({ status: model.status === 'completed' ? 200 : 202, json: { material: material(), reused: true } });
    });
    return { model, requests, errors };
  }

  it('saves safely, preserves a conflicted draft, replays a lost response and confirms explicit clearing', async () => {
    const page = await browser.newPage(), service = await fixture(page);
    await page.goto('https://api.example/api/lti/launch');
    const panel = page.locator('#material-management');
    await panel.locator('summary').click();
    const description = panel.locator('#management-description'), transcript = panel.locator('#management-transcript');
    await description.fill('First edit');
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
    await panel.getByText('Changes saved.', { exact: true }).waitFor();
    expect(service.model.description).toBe('First edit');
    expect(await panel.locator('img,script').count()).toBe(0);
    await description.fill('My draft to preserve'); service.model.conflicts = true;
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
    await panel.getByText('The material changed or is busy.', { exact: false }).waitFor();
    expect(await description.inputValue()).toBe('My draft to preserve');
    service.model.conflicts = false; service.model.loseResponse = true;
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
    await panel.getByText('Unable to complete this operation.', { exact: false }).waitFor();
    const afterLost = service.model.mutations;
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
    await panel.getByText('Changes saved.', { exact: true }).waitFor();
    const saves = service.requests.filter(r => r.path.endsWith('/management') && r.body.action === 'update');
    expect(saves.at(-1)?.body.operationId).toBe(saves.at(-2)?.body.operationId);
    expect(service.model.mutations).toBe(afterLost);
    await transcript.fill('invalid SRT');
    await panel.getByRole('button', {name:'Save changes',exact:true}).click();
    await panel.getByText('Use valid SRT up to 2 MiB', {exact:false}).waitFor();
    expect(await transcript.inputValue()).toBe('invalid SRT');
    await panel.getByRole('button', {name:'Refresh materials',exact:true}).click();
    await page.getByRole('dialog').getByRole('button', {name:'Cancel',exact:true}).click();
    expect(await transcript.inputValue()).toBe('invalid SRT');
    await transcript.fill('');
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(service.model.transcript).toBe(srt);
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
    await panel.getByText('Processing queued.', { exact: false }).waitFor();
    expect(service.model.transcript).toBe('');
    expect(await page.locator('#send').isDisabled()).toBe(true);
    expect(await transcript.getAttribute('readonly')).not.toBeNull();
    service.model.status = 'completed'; service.model.version++;
    await panel.getByRole('button', { name: 'Refresh materials', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')!.disabled);
    await page.setViewportSize({ width: 360, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if(process.env.LTI_BROWSER_ARTIFACT_DIR)await page.screenshot({path:join(process.env.LTI_BROWSER_ARTIFACT_DIR,'teacher-editor-mobile.png'),fullPage:true});
    expect(service.errors).toEqual([]); await page.close();
  }, 30000);

  it('updates remote processing state while retaining the local text and optimistic revision', async () => {
    const page=await browser.newPage(),service=await fixture(page);
    await page.goto('https://api.example/api/lti/launch');
    const panel=page.locator('#material-management'),description=panel.locator('#management-description');
    await panel.locator('summary').click();await description.fill('Local draft must survive');
    await panel.locator('summary').click();
    service.model.status='indexing';service.model.description='Another teacher saved';service.model.version++;
    await panel.locator('summary').click();
    await panel.getByText('Updating search index',{exact:false}).waitFor();
    expect(await description.inputValue()).toBe('Local draft must survive');
    expect(await description.getAttribute('readonly')).not.toBeNull();
    service.model.status='completed';service.model.version++;
    await page.waitForFunction(()=>!document.querySelector<HTMLTextAreaElement>('#management-description')!.readOnly);
    expect(await description.inputValue()).toBe('Local draft must survive');
    await panel.getByRole('button',{name:'Save changes',exact:true}).click();
    await panel.getByText('The material changed or is busy.',{exact:false}).waitFor();
    expect(service.model.description).toBe('Another teacher saved');
    expect(await description.inputValue()).toBe('Local draft must survive');
    expect(service.errors).toEqual([]);await page.close();
  },20000);

  it.skipIf(!process.env.LTI_MOODLE_PLUGIN_PATH)('opens a late native panel for processing-only material without reloading, and preserves a revoked draft', async () => {
    const page = await browser.newPage(), service = await fixture(page, 'indexing'), plugin = process.env.LTI_MOODLE_PLUGIN_PATH!;
    const render = async (name: string, heading: string) => (await readFile(join(plugin, 'templates', name+'.mustache'), 'utf8'))
      .replace(/\{\{![\s\S]*?\}\}/g, '').replace(/\{\{heading\}\}/g, heading).replace(/\{\{unavailable\}\}/g, 'Unavailable');
    const [management, qa, personal] = await Promise.all([render('management', 'Manage course materials'), render('qa', 'Course Q&A'), render('personal_history', 'My AI conversations')]);
    const [chatJs, managementJs, qaJs, personalJs, css] = await Promise.all(['chat.js', 'management.js', 'qa.js', 'personal_history.js', 'styles.css'].map(name => readFile(join(plugin, name), 'utf8')));
    await page.route('https://lms.example/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><style>${css}.local-videoq-questions{height:650px}</style>
<div class="local-videoq-workspace" data-videoq-origin="https://api.example"><section class="local-videoq-questions">${management}${qa}${personal}
<div id="videoq-native-chat"><div role="log"><p id="videoq-native-empty">Ask a question</p></div><p role="status"></p><fieldset disabled><form><textarea data-region="send-message-txt"></textarea><button data-action="send-message"><span data-region="send-icon-container">Send</span><span data-region="loading-icon-container" class="hidden">Loading</span></button></form></fieldset></div>
<iframe id="videoq-questions" class="local-videoq-transport" aria-hidden="true" tabindex="-1" title="Course questions" src="https://api.example/api/lti/launch"></iframe></section></div>
<script>window.events=[];window.addEventListener('message',event=>{if(event.origin==='https://api.example')window.events.push(event.data);});</script>
<script>${chatJs}</script><script>${qaJs}</script><script>${personalJs}</script><script>setTimeout(()=>{const script=document.createElement('script');script.textContent=${scriptJson(managementJs)};document.body.append(script);},900);</script>` }));
    await page.goto('https://lms.example/course');
    await page.locator('#videoq-material-management').waitFor({state:'visible'});
    const tool = page.frameLocator('#videoq-questions'), panel = tool.locator('#material-management');
    await tool.locator('html').evaluate(() => {
      for(const [origin,source] of [['https://attacker.example',window.parent],['https://lms.example',window]] as const)
        window.dispatchEvent(new MessageEvent('message',{origin,source,data:{type:'videoq:management-ui',version:1,channel:'f'.repeat(32),videoId:1,open:true}}));
      window.dispatchEvent(new MessageEvent('message',{origin:'https://lms.example',source:window.parent,data:{type:'videoq:management-ui',version:1,channel:'f'.repeat(32),videoId:1,open:true}}));
    });
    expect(await tool.locator('body.moodle-management').count()).toBe(0);
    expect(service.requests.filter(r=>r.path.endsWith('/management'))).toHaveLength(0);
    await page.locator('#videoq-material-management summary').click();
    await panel.getByText('Updating search index', { exact: false }).waitFor();
    expect(await page.locator('#videoq-native-question').isDisabled()).toBe(true);
    expect(service.requests.some(r => r.path.endsWith('/history') || r.path.includes('/messages'))).toBe(false);
    expect(service.requests.some(r => r.path.endsWith('/conversations') && r.body.action === 'list')).toBe(true);
    const description = panel.locator('#management-description');
    expect(await description.getAttribute('readonly')).not.toBeNull();
    service.model.status = 'completed'; service.model.version++;service.model.learningHold=true;
    await panel.getByText('Waiting for Moodle synchronization',{exact:false}).waitFor();
    expect(await page.locator('#videoq-native-question').isDisabled()).toBe(true);
    service.model.learningHold=false;
    await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('#videoq-native-chat fieldset')!.disabled);
    await description.fill('Private unsaved teaching draft');
    service.model.permitted = false;
    await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
    await panel.getByText('Material management is unavailable.', { exact: false }).waitFor();
    expect(await description.inputValue()).toBe('Private unsaved teaching draft');
    expect(await description.getAttribute('readonly')).not.toBeNull();
    expect(await panel.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true);
    expect(await page.locator('#videoq-questions').getAttribute('aria-hidden')).toBeNull();
    await page.locator('#videoq-course-qa summary').click();
    await tool.locator('body.moodle-qa').waitFor();
    expect(await page.locator('.local-videoq-management-open').count()).toBe(0);
    await page.locator('#videoq-material-management summary').click();
    await tool.locator('body.moodle-management').waitFor();
    expect(await description.inputValue()).toBe('Private unsaved teaching draft');
    const events = await page.evaluate<string>('JSON.stringify(window.events)');
    expect(events).not.toMatch(/private-management-token|signed-token|browser-secret|Private unsaved teaching draft/);
    expect(service.requests.filter(r => r.path.endsWith('/session'))).toHaveLength(1);
    expect(await page.locator('iframe').count()).toBe(1);
    await page.setViewportSize({width:360,height:720});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.LTI_BROWSER_ARTIFACT_DIR)await page.screenshot({path:join(process.env.LTI_BROWSER_ARTIFACT_DIR,'teacher-native-revoked-draft-mobile.png'),fullPage:true});
    expect(service.errors).toEqual([]); await page.close();
  }, 30000);
});
