import type { LtiLocale } from './locale';
export const courseHistoryCopy = {
  ja: { chat: 'チャット', history: '講座の質問履歴', csv: 'CSV', loading: '読み込み中…',
    empty: '履歴はありません', error: '質問履歴を読み込めません。再度お試しください。', shared: '共有リンク利用者' },
  en: { chat: 'Chat', history: 'Course question history', csv: 'CSV', loading: 'Loading…',
    empty: 'No history yet', error: 'Unable to load question history. Please try again.', shared: 'Shared link user' },
};
export function courseHistoryMarkup(locale: LtiLocale) {
  const c = courseHistoryCopy[locale];
  return `<div data-course-history-tabs class="classroom-chat-toolbar" hidden><button type="button" data-course-chat-tab aria-pressed="true">${c.chat}</button><button type="button" data-course-history-tab aria-pressed="false">${c.history}</button></div><section data-course-history-panel class="course-owner-history" hidden><button type="button" data-course-history-csv>${c.csv}</button><p data-course-history-status role="status"></p><div data-course-history-content></div></section>`;
}
