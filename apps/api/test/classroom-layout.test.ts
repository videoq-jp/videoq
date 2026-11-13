// @vitest-environment jsdom
import { createContext, Script } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { questionView } from '../src/features/lti/view';
import { classroomLayoutScript } from '../src/features/classroom/layout';
function button(id: string) { return document.getElementById(id) as HTMLButtonElement; }
function harness(initialMobile = false) {
  document.body.innerHTML = questionView('nonce', '', '', 'ja', [], { bootstrapScript: '', playerScript: '' });
  let mobile = initialMobile;
  const listeners = new Set<() => void>();
  const media = { get matches() { return mobile; }, addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener) };
  const question = document.getElementById('question') as HTMLTextAreaElement;
  question.disabled = false;button('send').disabled = false;
  const personalPanel = document.getElementById('personal-history') as HTMLDetailsElement;
  personalPanel.hidden = false;
  const personalNew = vi.fn();
  const context = createContext({ document, window: { matchMedia: () => media, addEventListener: vi.fn() },
    question, send: button('send'), personalPanel, personalNew, sessionReady: true,
    features: { conversations: true }, personalAllowed: true, classroomSelected: 1,
    qaPanel: document.getElementById('course-qa'), materialsPanel: document.getElementById('course-materials'),
    materialSelect: document.getElementById('material-video'),
  });
  new Script(classroomLayoutScript('ja')).runInContext(context);
  return { resize(value: boolean) { mobile = value;listeners.forEach(listener => listener()); }, question, personalPanel, personalNew };
}
afterEach(() => { document.body.replaceChildren(); });
it('keeps the desktop viewer arrangement: video/details at left and videos/assistant tabs at right', () => {
  harness();
  expect(document.getElementById('classroom-details')!.parentElement!.id).toBe('classroom-learning');
  expect(button('classroom-side-tab-details').hidden).toBe(true);
  button('classroom-side-tab-videos').click();
  expect(document.getElementById('classroom-side-panel-videos')!.hidden).toBe(false);
  expect(document.getElementById('classroom-side-panel-assistant')!.hidden).toBe(true);
  expect(button('classroom-side-tab-videos').getAttribute('aria-selected')).toBe('true');
  button('classroom-side-tab-assistant').click();
  expect(document.getElementById('classroom-side-panel-assistant')!.hidden).toBe(false);
});
it('supports keyboard navigation and skips the desktop-only hidden details tab', () => {
  harness();
  const assistant = button('classroom-side-tab-assistant');assistant.focus();
  assistant.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(document.activeElement).toBe(button('classroom-side-tab-videos'));
  expect(button('classroom-side-tab-videos').tabIndex).toBe(0);
  expect(assistant.tabIndex).toBe(-1);
});
it('moves the same details panel on mobile and collapses the mounted player when composing a question', () => {
  const ui = harness();
  const details = document.getElementById('classroom-details'), video = document.getElementById('classroom-media');
  ui.resize(true);
  expect(document.getElementById('classroom-side-panel-details')!.contains(details)).toBe(true);
  button('classroom-side-tab-details').click();
  expect(document.getElementById('classroom-side-panel-details')!.hidden).toBe(false);
  button('classroom-detail-tab-qa').click();
  expect((document.getElementById('course-qa') as HTMLDetailsElement).open).toBe(true);
  button('classroom-side-tab-assistant').click();ui.question.focus();
  expect(document.getElementById('classroom-player-media')!.hidden).toBe(true);
  expect(document.getElementById('classroom-media')).toBe(video);
  button('classroom-player-toggle').click();
  expect(document.getElementById('classroom-player-media')!.hidden).toBe(false);
  ui.resize(false);
  expect(document.getElementById('classroom-learning')!.contains(details)).toBe(true);
});
it('matches the core viewer without learner conversation-management controls', () => {
  harness();
  expect(document.getElementById('classroom-history-toggle')).toBeNull();
  expect(document.getElementById('classroom-conversation-new')).toBeNull();
  expect(document.querySelector('[data-course-history-tabs]')!.hasAttribute('hidden')).toBe(true);
  expect(document.getElementById('personal-history')!.closest('[hidden]')).not.toBeNull();
});
