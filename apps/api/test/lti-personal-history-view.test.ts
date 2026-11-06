import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { questionView, scriptJson } from '../src/features/lti/view';

const browserTests = process.env.LTI_BROWSER_TESTS === '1' ? describe : describe.skip;
const inputSchema = z.object({ action: z.string().optional(), conversationId: z.string().optional(), beforeTurnId: z.string().optional(),
  limit: z.number().optional(), offset: z.number().optional(), resumeConversation: z.boolean().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).optional() }).passthrough();
browserTests('Moodle personal conversation UI', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LTI_CHROMIUM_EXECUTABLE_PATH }); });
  afterAll(async () => { await browser?.close(); });
  async function fixture(page: Page, empty = false) {
    page.setDefaultTimeout(5000);
    const requests: { path: string; input: z.infer<typeof inputSchema> }[] = [], errors: string[] = [];
    const answer = { segments: [{ text: 'Stored answer', sourceIds: [] as number[] }], sources: [] };
    const turns = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => ({ id: String(i+1), question: prefix+' '+(i+1), answer,
      createdAt: '2026-11-06T00:00:00Z', feedback: null }));
    const conversations = Array.from({ length: empty ? 0 : 21 }, (_, i) => ({ id: crypto.randomUUID(), title: i === 0 ? '<img src=x onerror=alert(1)>' : 'Conversation '+i,
      createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', isGenerating: false,
      turns: turns(i === 0 ? 141 : 1, i === 0 ? 'Archive question' : 'Second question '+i) }));
    let permitted = true;
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { if (location.origin === 'https://api.example') sessionStorage.setItem('videoq-lti:'+'a'.repeat(64), 'browser-secret'); });
    await page.route('https://api.example/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/lti/launch') { await route.fulfill({ contentType: 'text/html', body: questionView('nonce','a'.repeat(64),'signed-token','en',['https://lms.example']) }); return; }
      if (path === '/api/lti/session') { await route.fulfill({ json: { token: 'private-history-token', features: { conversations: true, transcripts: true, qa: true },
        learningAvailable: !empty,...(empty ? {} : {playback: { videoId: 1, parentOrigins: ['https://lms.example'], videos: [{ videoId: 1, lesson: 'first', title: 'Lesson' }] }}) } }); return; }
      expect(route.request().headers().authorization).toBe('Bearer private-history-token');
      if (path === '/api/lti/history') { await route.fulfill({ json: { turns: [] } }); return; }
      const input = inputSchema.parse(route.request().postDataJSON()); requests.push({ path, input });
      if (path === '/api/lti/materials') { await route.fulfill({ json: { permissions: { manageOwnHistory: permitted, viewQa: true, viewTranscript: true }, videos: empty ? [] : [{ videoId: 1, title: 'Lesson', lesson: 'first' }] } }); return; }
      if (path === '/api/lti/qa') { await route.fulfill({ json: { data: { items: [], total: 0, canPost: true, canVote: true, canModerate: false }, permissions: { viewQa: true, postQa: true }, videos: [] } }); return; }
      if (!permitted) { await route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }); return; }
      if (path === '/api/lti/messages/stream') {
        let conversation = conversations.find(c => c.id === input.conversationId);
        if (!conversation) { conversation = { id: input.conversationId!, title: 'New conversation', createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', isGenerating: false, turns: [] }; conversations.unshift(conversation); }
        conversation.turns.push({ id: String(conversation.turns.length+1), question: input.messages!.at(-1)!.content, answer, createdAt: '2026-11-06T00:00:00Z', feedback: null });
        await route.fulfill({ json: { answer, feedbackId: 'c'.repeat(64), feedback: null } }); return;
      }
      if (path !== '/api/lti/conversations') throw new Error('Unexpected route '+path);
      if (input.action === 'list') { const offset = input.offset ?? 0, limit = input.limit ?? 20; await route.fulfill({ json: { items: conversations.slice(offset,offset+limit).map(({ turns: _turns,...c }) => c), hasMore: conversations.length>offset+limit } }); return; }
      const index = conversations.findIndex(c => c.id === input.conversationId), conversation = conversations[index];
      if (!conversation) { await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }); return; }
      if (input.action === 'delete') { conversations.splice(index,1); await route.fulfill({ json: { success: true } }); return; }
      const candidates = conversation.turns.filter(t => !input.beforeTurnId || BigInt(t.id)<BigInt(input.beforeTurnId));
      const selected = candidates.slice(-(input.limit ?? 50));
      await route.fulfill({ json: { ...conversation, turns: selected.map(turn => ({ ...turn, ...(input.action === 'get' ? { feedbackId: 'd'.repeat(64) } : {}) })), hasMore: candidates.length>selected.length } });
    });
    return { requests, errors, conversations, revoke: () => { permitted = false; } };
  }
  it('opens coursewide Q&A and refreshes own history without enabling an empty-course AI composer', async () => {
    const page=await browser.newPage(),service=await fixture(page,true);
    try{
      await page.goto('https://api.example/api/lti/launch');
      await page.locator('#personal-history summary').waitFor();
      await expect.poll(()=>service.requests.filter(r=>r.path==='/api/lti/conversations').length).toBeGreaterThan(0);
      expect(await page.locator('#send').isDisabled()).toBe(true);
      await page.locator('#personal-history summary').click();
      const refresh=page.locator('#personal-history').getByRole('button',{name:'Refresh',exact:true});
      await expect.poll(()=>refresh.isEnabled()).toBe(true);
      const before=service.requests.filter(r=>r.path==='/api/lti/conversations').length;
      await refresh.click();
      await expect.poll(()=>service.requests.filter(r=>r.path==='/api/lti/conversations').length).toBeGreaterThan(before);
      expect(await page.locator('#personal-history').getByRole('button',{name:'New conversation',exact:true}).isDisabled()).toBe(true);
      await page.locator('#course-qa summary').click();
      await expect.poll(()=>service.requests.some(r=>r.path==='/api/lti/qa')).toBe(true);
      expect(service.requests.some(r=>r.path.includes('/messages'))).toBe(false);
      expect(service.errors).toEqual([]);
    }finally{await page.close();}
  });
  it('resumes, pages, exports every turn, deletes with confirmation and starts a new isolated conversation', async () => {
    const page = await browser.newPage(), service = await fixture(page);
    await page.goto('https://api.example/api/lti/launch');
    await page.locator('#send').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')!.disabled);
    const firstId = service.conversations[0].id;
    await page.locator('#question').fill('A new personal question'); await page.locator('#send').click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')!.disabled);
    const sent = service.requests.find(r => r.path.endsWith('/messages/stream'))!.input;
    expect(sent).toMatchObject({ conversationId: firstId, resumeConversation: true, messages: [{ role: 'user', content: 'A new personal question' }] });
    await page.locator('#personal-history summary').click();
    const panel = page.locator('#personal-history');
    await panel.getByRole('heading', { name: '<img src=x onerror=alert(1)>', exact: true }).waitFor();
    expect(await panel.locator('img').count()).toBe(0);
    await panel.getByRole('button', { name: 'Next', exact: true }).click();
    await panel.getByRole('heading', { name: 'Conversation 20', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Previous', exact: true }).click();
    await panel.getByRole('button', { name: 'Read', exact: true }).first().click();
    await panel.getByText('Archive question 93', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Older messages', exact: true }).click();
    await panel.getByText('Archive question 43', { exact: true }).waitFor();
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download conversation', exact: true }).click();
    const file = await download, path = await file.path();
    expect(file.suggestedFilename()).toBe('videoq-conversation-'+firstId+'.ndjson');
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { id: string; question?: string });
    expect(lines).toHaveLength(143); expect(lines[1].id).toBe('1'); expect(lines.at(-1)?.question).toBe('A new personal question');
    expect(JSON.stringify(lines)).not.toMatch(/feedbackId|private-history-token|ownerUserId|subjectKey/);
    await panel.getByRole('button', { name: 'Delete conversation', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(service.conversations.some(c => c.id===firstId)).toBe(true);
    await panel.getByRole('button', { name: 'Delete conversation', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete conversation', exact: true }).click();
    await panel.getByRole('heading', { name: 'Conversation 1', exact: true }).waitFor();
    expect(service.conversations.some(c => c.id===firstId)).toBe(false);
    expect(await page.locator('#messages .message').count()).toBe(0);
    await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.locator('#question').fill('Fresh conversation'); await page.locator('#send').click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#send')!.disabled);
    const requests = service.requests.filter(r=>r.path.endsWith('/messages/stream'));
    expect(requests[1].input.conversationId).not.toBe(firstId); expect(requests[1].input.resumeConversation).toBe(false);
    service.revoke(); await page.locator('#personal-history summary').click();
    await panel.waitFor({ state: 'hidden' });
    expect(await page.locator('#messages .message').count()).toBe(0);
    await page.setViewportSize({ width: 360, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(service.errors).toEqual([]); await page.close();
  }, 25000);

  it.skipIf(!process.env.LTI_MOODLE_PLUGIN_PATH)('uses the actual late-loading Moodle panel, replaces the native transcript and switches panels without a new session', async () => {
    const plugin = process.env.LTI_MOODLE_PLUGIN_PATH!, page = await browser.newPage(), service = await fixture(page);
    const render = async (name: string, labels: Record<string,string>) => (await readFile(join(plugin,'templates',name+'.mustache'),'utf8')).replace(/\{\{![\s\S]*?\}\}/g,'').replace(/\{\{(\w+)\}\}/g,(_m,key:string)=>labels[key]??'');
    const [qa, personal, transcript] = await Promise.all([render('qa',{heading:'Course Q&A',unavailable:'Unavailable'}),render('personal_history',{heading:'My AI conversations',unavailable:'Saved conversations unavailable'}),render('transcript',{heading:'Transcripts',lesson:'Lesson',refresh:'Refresh lessons',more:'More'})]);
    const [chatJs,qaJs,personalJs,transcriptJs,css] = await Promise.all(['chat.js','qa.js','personal_history.js','transcript.js','styles.css'].map(name=>readFile(join(plugin,name),'utf8')));
    await page.route('https://lms.example/**', route => route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><style>${css}.local-videoq-questions{height:650px}</style>
<div class="local-videoq-workspace" data-videoq-origin="https://api.example"><section class="local-videoq-questions">${qa}${personal}${transcript}
<div id="videoq-native-chat" data-you="You" data-assistant="VideoQ"><div id="videoq-native-messages" role="log"><p id="videoq-native-empty">Ask a question</p></div><p role="status"></p><fieldset><form><textarea data-region="send-message-txt"></textarea><button data-action="send-message"><span data-region="send-icon-container">Send</span><span data-region="loading-icon-container" class="hidden">Loading</span></button></form></fieldset>
<template id="videoq-native-question-template"><article data-region="message"><span data-region="time-created"></span><div data-region="text-container"></div></article></template><template id="videoq-native-answer-template"><article data-region="message"><span data-region="time-created"></span><div data-region="text-container"></div></article></template><template id="videoq-native-feedback-template"><div><button data-feedback="good">Good</button><button data-feedback="bad">Bad</button><small role="status"></small></div></template></div>
<iframe class="local-videoq-transport" id="videoq-questions" title="Lesson assistant" aria-hidden="true" tabindex="-1" src="https://api.example/api/lti/launch"></iframe></section></div>
<script>window.events=[];window.addEventListener('message',event=>{if(event.origin==='https://api.example')window.events.push(event.data);});</script>
<script>${chatJs}</script><script>${transcriptJs}</script><script>${qaJs}</script><script>setTimeout(()=>{const script=document.createElement('script');script.textContent=${scriptJson(personalJs)};document.body.append(script);},1200);</script>`}));
    await page.goto('https://lms.example/course');
    await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>('#videoq-native-chat fieldset')!.disabled);
    await page.waitForFunction(() => document.querySelector('#videoq-native-chat [role="log"]')!.textContent!.includes('Archive question 141'));
    await page.locator('#videoq-personal-history summary').click();
    const tool=page.frameLocator('#videoq-questions'), panel=tool.locator('#personal-history');
    await panel.getByRole('heading',{name:'Conversation 1',exact:true}).waitFor();
    await panel.getByRole('button',{name:'Continue this conversation',exact:true}).nth(1).click();
    await page.waitForFunction(() => document.querySelector('#videoq-native-chat [role="log"]')!.textContent!.includes('Second question 1 1'));
    expect(await page.locator('#videoq-native-chat [role="log"]').textContent()).not.toContain('Archive question 141');
    await page.locator('#videoq-personal-history summary').click();
    await panel.getByRole('heading',{name:'Conversation 1',exact:true}).waitFor();
    await page.locator('#videoq-course-qa summary').click();
    await tool.locator('body.moodle-qa').waitFor();
    expect(await page.locator('.local-videoq-personal-open').count()).toBe(0);
    await page.locator('#videoq-personal-history summary').click();
    await tool.locator('body.moodle-personal-history').waitFor();
    expect(await page.locator('.local-videoq-qa-open').count()).toBe(0);
    expect(await page.locator('iframe').count()).toBe(1);
    expect(await page.evaluate<string>("JSON.stringify(window.events)")).not.toContain('private-history-token');
    expect(await page.evaluate<string>("JSON.stringify(window.events)")).not.toContain('feedbackId');
    service.revoke(); await panel.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByText('Saved conversations unavailable',{exact:true}).waitFor();
    await page.locator('#videoq-native-chat').waitFor({state:'visible'});
    expect(service.errors).toEqual([]); await page.close();
  },25000);
});
