// @vitest-environment jsdom
import { createContext, Script } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { courseHistoryClientScript } from '../src/features/lti/course-history-client';
import { courseHistoryMarkup, courseHistoryCopy } from '../src/features/lti/course-history-view';
function harness(request = vi.fn()) {
  document.body.innerHTML = '<div id="root">' + courseHistoryMarkup('ja') + '<div id="chat">Chat</div></div>';
  const root = document.getElementById('root')!, chat = document.getElementById('chat')!;
  const create = new Script(courseHistoryClientScript + ';createCourseHistory;').runInContext(createContext({document,URL,setTimeout}));
  const ui = create(root, request, vi.fn(), [chat], courseHistoryCopy.ja);
  const button = (name: string) => root.querySelector<HTMLButtonElement>('[data-course-' + name + ']')!;
  return { ...ui, root, chat, button, request };
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
it('keeps learner chat automatic without adding conversation-management controls', () => {
  const ui = harness();
  expect(ui.root.querySelector('[data-course-history-tabs]')!.hasAttribute('hidden')).toBe(true);
  expect(ui.chat.hidden).toBe(false);expect(ui.request).not.toHaveBeenCalled();
  expect(ui.root.textContent).not.toContain('新しい会話');
});
it('shows the owner history, attribution using the native course log contract', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({count:51,results:[{created_at:'2026-11-13T00:00:00Z',asked_by:{username:'生徒 A',email:'student@example.com'},
    question:'<img src=x onerror=alert(1)>',answer:{segments:[{text:'回答',sourceIds:[]}],sources:[]},feedback:'good'}]}));
  const ui = harness(request);ui.availability(true);ui.button('history-tab').click();
  await vi.waitFor(() => expect(ui.root.textContent).toContain('student@example.com'));
  expect(ui.chat.hidden).toBe(true);expect(ui.root.querySelector('img')).toBeNull();
  expect(request).toHaveBeenCalledWith({action:'list'});
  ui.button('chat-tab').click();expect(ui.chat.hidden).toBe(false);
});
it('clears owner data on revoked access and ignores an already pending history response', async () => {
  let resolve!: (response: Response) => void;
  const request = vi.fn(() => new Promise<Response>(done => {resolve = done;}));
  const ui = harness(request);ui.availability(true);ui.button('history-tab').click();
  ui.availability(false);
  resolve(Response.json({count:1,results:[{question:'Private',created_at:'2026-11-13',answer:{segments:[],sources:[]}}]}));
  await Promise.resolve();await Promise.resolve();
  expect(ui.root.textContent).not.toContain('Private');expect(ui.chat.hidden).toBe(false);
  expect(ui.root.querySelector('[data-course-history-tabs]')!.hasAttribute('hidden')).toBe(true);
});
it('hides owner controls when the server refuses a stale teacher grant', async () => {
  const ui = harness(vi.fn().mockResolvedValue(Response.json({}, {status:403})));
  ui.availability(true);ui.button('history-tab').click();
  await vi.waitFor(() => expect(ui.root.querySelector('[data-course-history-tabs]')!.hasAttribute('hidden')).toBe(true));
  expect(ui.chat.hidden).toBe(false);
});
