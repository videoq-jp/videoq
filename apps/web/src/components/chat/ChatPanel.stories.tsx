import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import i18n from '@/i18n/config';
import { appQueryClient } from '@/lib/queryClient';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { ChatPanel } from './ChatPanel';
import { authFixtures } from '../../../.storybook/fixtures/auth';
import { answer, answerData, citations, longAnswer } from '../../../.storybook/fixtures/chat';
import { englishCitations, englishQuestion, mixedHistory } from '../../../.storybook/fixtures/chatHistory';
import { answerEvents, contentEvents, courseId, courseHistory, englishHistory, firstTokens, question, reviewedEvents, searchingEvents, searchQuery, shareToken } from '../../../.storybook/fixtures/chatPanel';
import { chatRequest, createChatPanelMock, csvRequest, feedbackRequest, historyError, historyRequest, type ChatPanelScenario } from '../../../.storybook/mocks/chatPanel';

let network: ReturnType<typeof createChatPanelMock>;
const label = (key: string) => i18n.t(`chat.${key}`);
const english = () => i18n.language.startsWith('en');
const sharedFeedbackToken = 'storybook-issued-token';

function PanelExample({ lifecycleControl, ...args }: ComponentProps<typeof ChatPanel> & { lifecycleControl: boolean }) {
  const [visible, setVisible] = useState(true);
  return <div data-testid="chat-panel-frame" style={{ maxWidth: 800 }}>
    {lifecycleControl && <Button variant="outline" className="mb-2" onClick={() => setVisible(value => !value)}>{visible ? 'Unmount panel' : 'Mount panel'}</Button>}
    {visible && <ChatPanel {...args} />}
  </div>;
}

const meta = {
  title: 'Chat/ChatPanel',
  component: ChatPanel,
  args: { courseId, onVideoPlay: fn(), className: 'h-[min(720px,calc(100dvh-32px))]' },
  render: (args, { parameters }) => <PanelExample {...args} lifecycleControl={parameters.lifecycleControl === true} />,
  parameters: { api: { auth: authFixtures.user }, docs: { story: { inline: false, height: '800px' } } },
  beforeEach({ parameters, msw, args }) {
    const mock = createChatPanelMock({
      events: answerEvents(english(), args.shareToken ? sharedFeedbackToken : undefined), history: english() ? englishHistory : courseHistory,
      ...parameters.chat as ChatPanelScenario | undefined,
    });
    network = mock;
    msw.use(...mock.handlers);
    return () => {
      mock.dispose();
    };
  },
} satisfies Meta<typeof ChatPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];
const input = ({ canvas }: Context) => canvas.getByRole('textbox', { name: label('placeholder') });
const chatButton = ({ canvas }: Context) => canvas.getByRole('button', { name: label('currentConversation') });
const historyButton = ({ canvas }: Context) => canvas.getByRole('button', { name: label('history') });
async function send(context: Context, text = english() ? englishQuestion : question) {
  await context.userEvent.type(input(context), text);
  await context.userEvent.click(context.canvas.getByRole('button', { name: i18n.t('common.actions.send') }));
  await waitFor(() => expect(chatRequest).toHaveBeenCalled());
}
async function complete(context: Context) {
  await send(context);
  // Completion metadata follows the final batch of text in the render queue.
  await context.canvas.findByRole('button', { name: label('feedbackGood') }, { timeout: 10000 });
  await waitFor(() => expect(input(context)).toBeEnabled());
}
async function openHistory(context: Context) {
  await context.userEvent.click(historyButton(context));
  await waitFor(() => expect(historyRequest).toHaveBeenCalled());
}
async function assertBusy(context: Context) {
  await expect(input(context)).toBeDisabled();
  for (const name of [i18n.t('common.actions.send')]) await expect(context.canvas.getByRole('button', { name })).toBeDisabled();
}
const waiting = { events: [], keepOpen: true } satisfies ChatPanelScenario;

export const Initial: Story = { async play(context) {
  await expect(context.canvas.getByText(label('assistantGreeting'))).toBeVisible();
  await expect(context.canvas.queryByRole('button', { name: label('newConsultation') })).not.toBeInTheDocument();
  await expect(context.canvas.queryByRole('button', { name: label('myConversations') })).not.toBeInTheDocument();
  await expect(context.canvas.getByRole('button', { name: i18n.t('common.actions.send') })).toBeDisabled();
  await expect(historyRequest).not.toHaveBeenCalled();
} };
export const NoCourse: Story = { args: { courseId: undefined }, async play(context) {
  await expect(context.canvas.queryByRole('button', { name: label('history') })).not.toBeInTheDocument();
  await complete(context);
  await expect(chatRequest.mock.calls[0][0]).not.toHaveProperty('course_id');
} };
export const HistoryHidden: Story = { args: { showHistory: false }, async play({ canvas }) {
  await expect(canvas.queryByRole('button', { name: label('history') })).not.toBeInTheDocument();
} };
export const Conversation: Story = { async play(context) {
  await complete(context);
  await expect(chatRequest).toHaveBeenCalledWith({ course_id: courseId, messages: [{ role: 'user', content: english() ? englishQuestion : question }], share_slug: undefined, conversation_id: expect.any(String), resume_conversation: false });
} };
export const IndependentQuestions: Story = { async play(context) {
  await send(context, '内積とは？');
  await waitFor(() => expect(input(context)).toBeEnabled());
  await send(context, '具体例を教えて');
  await waitFor(() => expect(chatRequest).toHaveBeenCalledTimes(2));
  await expect(chatRequest.mock.calls[1][0].messages).toEqual([{ role: 'user', content: '具体例を教えて' }]);
  await expect(context.canvas.getByText('内積とは？')).toBeVisible();
  await waitFor(() => expect(input(context)).toBeEnabled());
} };
export const SharedLink: Story = { args: { shareToken }, parameters: { api: { auth: authFixtures.loggedOut } }, async play(context) {
  await complete(context);
  await expect(context.canvas.getByRole('heading', { level: 3 })).toHaveTextContent(label('title'));
  await expect(context.canvas.queryByRole('button', { name: label('history') })).not.toBeInTheDocument();
  await expect(chatRequest).toHaveBeenCalledWith(expect.objectContaining({ share_slug: shareToken }));
  await expect(historyRequest).not.toHaveBeenCalled();
  await context.userEvent.click(context.canvas.getByRole('button', { name: label('feedbackGood') }));
  await waitFor(() => expect(feedbackRequest).toHaveBeenCalledWith({ chatLogId: 101, feedback: 'good', shareSlug: shareToken, feedbackToken: sharedFeedbackToken }));
} };
export const AwaitingResponse: Story = { parameters: { chat: waiting }, async play(context) {
  await send(context); await assertBusy(context);
  await expect(context.canvas.getByRole('status')).toHaveTextContent(label('progress.preparing'));
  await expect(context.canvas.queryByRole('button', { name: label('feedbackGood') })).not.toBeInTheDocument();
} };
export const Searching: Story = { parameters: { chat: { events: searchingEvents, keepOpen: true } satisfies ChatPanelScenario }, async play(context) {
  await send(context); await assertBusy(context);
  const details = await context.canvas.findByRole('button', { name: `${label('progress.checkingVideos')}。${label('progress.details')}` });
  details.focus(); await context.userEvent.keyboard('{Enter}');
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(context.canvas.getByText(searchQuery)).toBeVisible();
} };
export const Reviewing: Story = { parameters: { chat: { events: reviewedEvents, keepOpen: true } satisfies ChatPanelScenario }, async play(context) {
  await send(context);
  await expect(await context.canvas.findByRole('status')).toHaveTextContent(label('progress.checkingVideos'));
} };
export const Streaming: Story = { parameters: { chat: { events: [...reviewedEvents, { type: 'text_delta', segmentIndex: 0, text: firstTokens }], keepOpen: true } satisfies ChatPanelScenario }, async play(context) {
  await send(context);
  await expect(await context.canvas.findByText(firstTokens)).toBeVisible();
  await assertBusy(context);
} };
export const StreamingTimestamps: Story = {
  name: 'Streaming timestamps / タイムスタンプの逐次表示',
  args: { suggestedQuestions: ['回転行列について教えて'] },
  parameters: {
    chat: {
      events: [
        ...reviewedEvents,
        ...contentEvents({ segments: [...answerData.segments, { text: `\n\n${longAnswer}`, sourceIds: [1] }], sources: citations }),
        { type: 'done', chat_log_id: 101, feedback: null },
      ],
    } satisfies ChatPanelScenario,
    docs: { description: { story: '質問を送信すると、長いサンプル回答を本番と同じ速度で表示します。引用は最初から時刻で表示されます。回答は固定のモックで、LLMには接続しません。再送して繰り返し確認できます。' } },
  },
};
export const CitationsBeforeCompletion: Story = {
  parameters: { chat: waiting },
  async play(context) {
    await send(context);
    const source = english() ? englishCitations[0] : citations[0];
    const name = `${source.title} ${source.start_time}`;
    network.emit([{ type: 'source', source }]);
    await expect(context.canvas.queryByRole('button', { name })).not.toBeInTheDocument();
    network.emit([{ type: 'text_delta', segmentIndex: 0, text: english() ? 'Answer' : '回答' }, { type: 'citation', segmentIndex: 0, sourceId: source.id }]);
    const citation = await context.canvas.findByRole('button', { name });
    await assertBusy(context);
    await expect(context.canvas.queryByRole('button', { name: label('feedbackGood') })).not.toBeInTheDocument();
    await expect(context.canvas.queryByText(`[${source.id}]`)).not.toBeInTheDocument();
    citation.focus();
    await context.userEvent.keyboard('{Enter}');
    await expect(context.args.onVideoPlay).toHaveBeenCalledWith(source.video_id, source.start_time);
    network.emit([{ type: 'text_delta', segmentIndex: 0, text: english() ? ' continues.' : 'が続きます。' }, { type: 'done', chat_log_id: 101, feedback: null }]);
    network.finish();
    await context.canvas.findByRole('button', { name: label('feedbackGood') });
    await expect(citation).toBeVisible();
    await expect(input(context)).toBeEnabled();
  },
};
export const CitationsBeforeCompletionEnglishMobile: Story = { ...CitationsBeforeCompletion, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const ProgressToComplete: Story = { parameters: { chat: waiting }, async play(context) {
  await AwaitingResponse.play!(context);
  network.emit(searchingEvents);
  await waitFor(() => expect(context.canvas.getByRole('status')).toHaveTextContent(label('progress.checkingVideos')));
  network.emit([{ type: 'text_delta', segmentIndex: 0, text: firstTokens }]);
  await expect(await context.canvas.findByText(firstTokens)).toBeVisible();
  network.emit([...contentEvents({ segments: [{ text: answer.slice(firstTokens.length), sourceIds: [1, 2] }], sources: citations }), { type: 'done', chat_log_id: 101, feedback: null }]);
  network.finish();
  await context.canvas.findByRole('button', { name: label('feedbackGood') });
  await waitFor(() => expect(input(context)).toBeEnabled());
} };
export const CompleteWithOpenConnection: Story = { parameters: { chat: { keepOpen: true } satisfies ChatPanelScenario }, async play(context) { await complete(context); } };
export const EmptyResponse: Story = { parameters: { chat: { events: [] } satisfies ChatPanelScenario }, async play(context) {
  await send(context); await waitFor(() => expect(input(context)).toBeEnabled());
  await expect(await context.canvas.findByText(label('error'))).toBeVisible();
  await expect(context.canvas.queryByRole('status')).not.toBeInTheDocument();
} };
export const StreamError: Story = { parameters: { chat: { events: [{ type: 'error', code: 'LLM_PROVIDER_ERROR', message: '' }] } satisfies ChatPanelScenario }, async play(context) {
  await send(context); await expect(await context.canvas.findByText(label('error'))).toBeVisible();
  await expect(input(context)).toBeEnabled();
} };
export const OverQuota: Story = { parameters: { chat: { events: [{ type: 'error', code: 'OVER_QUOTA', message: '' }] } satisfies ChatPanelScenario }, async play(context) {
  await send(context); await expect(await context.canvas.findByText(label('errorOverQuota'))).toBeVisible();
} };
export const NetworkFailure: Story = { parameters: { chat: { httpError: true } satisfies ChatPanelScenario }, async play(context) {
  await StreamError.play!(context);
} };
export const InterruptedResponse: Story = { parameters: { chat: { events: [...searchingEvents, { type: 'text_delta', segmentIndex: 0, text: firstTokens }], keepOpen: true } satisfies ChatPanelScenario }, async play(context) {
  await send(context); await context.canvas.findByText(firstTokens);
  network.emit([{ type: 'error', code: 'STREAM_INTERRUPTED', message: '' }]);
  network.finish();
  await expect(await context.canvas.findByText(label('error'))).toBeVisible();
  await expect(context.canvas.getByRole('status')).toHaveTextContent(label('progress.interrupted'));
  await waitFor(() => expect(input(context)).toBeEnabled());
} };
export const RetryAfterInterruption: Story = { parameters: InterruptedResponse.parameters, async play(context) {
  await InterruptedResponse.play!(context);
  await send(context, 'もう一度お願いします');
  await waitFor(() => expect(chatRequest).toHaveBeenCalledTimes(2));
  network.emit([...contentEvents({ segments: [{ text: answer.slice(firstTokens.length), sourceIds: [1, 2] }], sources: citations }), { type: 'done', chat_log_id: 101, feedback: null }]); network.finish();
  await context.canvas.findByRole('button', { name: label('feedbackGood') });
  await waitFor(() => expect(input(context)).toBeEnabled());
} };
export const DisconnectedBeforeDone: Story = {
  parameters: { chat: { events: [...reviewedEvents, ...contentEvents({ segments: [{ text: 'Partial', sourceIds: [1] }], sources: citations })], keepOpen: true } satisfies ChatPanelScenario },
  async play(context) {
    await send(context);
    await context.canvas.findByRole('button', { name: `${citations[0].title} ${citations[0].start_time}` });
    network.finish();
    await expect(await context.canvas.findByText(label('error'))).toBeVisible();
    await expect(context.canvas.getByRole('status')).toHaveTextContent(label('progress.interrupted'));
    await expect(context.canvas.queryByRole('button', { name: label('feedbackGood') })).not.toBeInTheDocument();
    await expect(context.canvas.queryByRole('button', { name: `${citations[0].title} ${citations[0].start_time}` })).not.toBeInTheDocument();
    await waitFor(() => expect(input(context)).toBeEnabled());
  },
};
export const HistoryDuringResponse: Story = { parameters: { chat: waiting }, async play(context) {
  await AwaitingResponse.play!(context); await openHistory(context);
  await context.canvas.findByText(courseHistory[0].asked_by!.email);
  network.emit(answerEvents()); network.finish();
  await expect(historyButton(context)).toHaveAttribute('aria-pressed', 'true');
  await context.userEvent.click(chatButton(context));
  await context.canvas.findByRole('button', { name: label('feedbackGood') });
  await waitFor(() => expect(input(context)).toBeEnabled());
} };
export const HistoryLoading: Story = { parameters: { chat: { historyState: 'pending' } satisfies ChatPanelScenario }, async play(context) {
  await openHistory(context); await expect(context.canvas.getByRole('progressbar')).toBeVisible();
  await expect(context.canvas.queryByText(label('historyEmpty'))).not.toBeInTheDocument();
} };
export const HistoryEmpty: Story = { parameters: { chat: { history: [] } satisfies ChatPanelScenario }, async play(context) {
  await openHistory(context); await expect(await context.canvas.findByText(label('historyEmpty'))).toBeVisible();
} };
export const HistoryLoaded: Story = { parameters: { chat: { history: mixedHistory.map(item => ({ ...item, course: courseId })) } satisfies ChatPanelScenario }, async play(context) {
  await openHistory(context);
  await expect(historyRequest).toHaveBeenCalledWith({ courseId, limit: 100, offset: 0 });
} };
export const HistoryFailed: Story = { parameters: { chat: { historyState: 'error' } satisfies ChatPanelScenario }, async play(context) {
  await openHistory(context); await expect(await context.canvas.findByRole('alert')).toHaveTextContent(historyError);
  await expect(context.canvas.queryByText(label('historyEmpty'))).not.toBeInTheDocument();
} };

function historyRefreshStory(state: 'pending' | 'error'): Story {
  return {
    parameters: { chat: { historyRefetch: state } satisfies ChatPanelScenario },
    async play(context) {
      await openHistory(context);
      await context.canvas.findByText((english() ? englishHistory[0] : courseHistory[0]).question);
      const item = english() ? englishHistory[0] : courseHistory[0];
      const question = context.canvas.getByText(item.question);
      const csv = context.canvas.getByRole('button', { name: 'CSV' });
      csv.focus();
      const queryKey = trpc.chat.history.queryKey({ courseId, limit: 100, offset: 0 });
      void appQueryClient.refetchQueries({ queryKey, exact: true });
      await waitFor(() => expect(historyRequest).toHaveBeenCalledTimes(2));
      if (state === 'error') await expect(await context.canvas.findByRole('alert')).toHaveTextContent(historyError);
      await expect(context.canvas.getByText(item.question)).toBe(question);
      await expect(question).toBeVisible();
      await expect(csv).toHaveFocus();
      await expect(csv).toBeEnabled();
      await expect(context.canvas.queryByRole('progressbar')).not.toBeInTheDocument();
    },
  };
}
export const HistoryBackgroundRefresh = historyRefreshStory('pending');
export const HistoryBackgroundRefreshEnglishMobile: Story = { ...HistoryBackgroundRefresh, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const HistoryBackgroundFailure = historyRefreshStory('error');
export const HistoryBackgroundFailureEnglishMobile: Story = { ...HistoryBackgroundFailure, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const FeedbackToggleAndHistory: Story = { async play(context) {
  await openHistory(context); await context.canvas.findByText((english() ? englishHistory[0] : courseHistory[0]).question);
  await context.userEvent.click(chatButton(context)); await complete(context);
  const good = context.canvas.getByRole('button', { name: label('feedbackGood') });
  const bad = context.canvas.getByRole('button', { name: label('feedbackBad') });
  for (const [button, value] of [[good, 'good'], [good, null], [bad, 'bad']] as const) {
    await context.userEvent.click(button);
    await waitFor(() => expect(feedbackRequest).toHaveBeenLastCalledWith({ chatLogId: 101, feedback: value }));
    await waitFor(() => expect(button).toBeEnabled());
  }
  await expect(bad).toHaveAttribute('aria-pressed', 'true');
  await openHistory(context); await context.canvas.findByText((english() ? englishHistory[0] : courseHistory[0]).question);
  await expect(context.canvasElement.querySelector('.lucide-thumbs-down')).toBeInTheDocument();
} };
export const FeedbackPending: Story = { parameters: { chat: { feedback: 'pending' } satisfies ChatPanelScenario }, async play(context) {
  await complete(context); await context.userEvent.click(context.canvas.getByRole('button', { name: label('feedbackGood') }));
  await waitFor(() => expect(context.canvas.getByRole('button', { name: label('feedbackGood') })).toBeDisabled());
  await expect(context.canvas.getByRole('button', { name: label('feedbackBad') })).toBeDisabled();
} };
export const FeedbackFailureThenRetry: Story = { parameters: { chat: { feedback: 'retry' } satisfies ChatPanelScenario }, async play(context) {
  await complete(context);
  const good = context.canvas.getByRole('button', { name: label('feedbackGood') });
  await context.userEvent.click(good);
  await waitFor(() => expect(feedbackRequest).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(good).toBeEnabled());
  await expect(good).toHaveAttribute('aria-pressed', 'false');
  await context.userEvent.click(good);
  await waitFor(() => expect(good).toHaveAttribute('aria-pressed', 'true'));
  await expect(feedbackRequest).toHaveBeenCalledTimes(2);
} };
export const KeyboardSendAndCitation: Story = { async play(context) {
  input(context).focus(); await context.userEvent.keyboard('キーボードから質問します{Enter}');
  const reference = english() ? englishCitations[0] : citations[0];
  const citation = await context.canvas.findByRole('button', { name: `${reference.title} ${reference.start_time}` });
  citation.focus(); await context.userEvent.keyboard('{Enter}');
  await expect(context.args.onVideoPlay).toHaveBeenCalledWith(reference.video_id, reference.start_time);
} };
export const SuggestedQuestions: Story = { args: { suggestedQuestions: [question, '回転行列を使った練習問題を出してください。'] }, parameters: { chat: waiting }, async play(context) {
  await context.userEvent.click(context.canvas.getByRole('button', { name: question }));
  await expect(input(context)).toHaveValue(question);
  await context.userEvent.click(context.canvas.getByRole('button', { name: i18n.t('common.actions.send') }));
  await waitFor(() => expect(input(context)).toBeDisabled());
  await expect(context.canvas.queryByRole('button', { name: question })).not.toBeInTheDocument();
  await context.userEvent.click(context.canvas.getByRole('button', { name: label('showSuggestions') }));
  await expect(context.canvas.getByRole('button', { name: question })).toBeDisabled();
} };
export const JapaneseMobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } }, async play(context) { await complete(context); } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } }, async play(context) {
  await complete(context);
  const frame = context.canvas.getByTestId('chat-panel-frame');
  await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
} };
export const LongAnswerMobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } }, parameters: { chat: { events: [{ type: 'text_delta', segmentIndex: 0, text: longAnswer }, { type: 'done', chat_log_id: 101, feedback: null }] } satisfies ChatPanelScenario }, async play(context) {
  await complete(context);
  const scroller = context.canvasElement.querySelector('.overflow-y-auto')!;
  await expect(scroller.scrollTop).toBeGreaterThan(0);
  await expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
  const composer = input(context).getBoundingClientRect();
  await expect(composer.bottom).toBeLessThanOrEqual(context.canvasElement.ownerDocument.documentElement.clientHeight);
} };
export const ExportCsv: Story = { async play(context) {
  await openHistory(context); const csv = await context.canvas.findByRole('button', { name: 'CSV' });
  await context.userEvent.click(csv); await waitFor(() => expect(csvRequest).toHaveBeenCalledWith({ courseId }));
  await waitFor(() => expect(csv).toBeEnabled());
} };
export const ExportingCsv: Story = { parameters: { chat: { csv: 'pending' } satisfies ChatPanelScenario }, async play(context) {
  await openHistory(context); const csv = await context.canvas.findByRole('button', { name: 'CSV' });
  await context.userEvent.click(csv); await waitFor(() => expect(csv).toBeDisabled());
} };
export const ExportFailed: Story = { parameters: { chat: { csv: 'error' } satisfies ChatPanelScenario }, async play(context) { await ExportCsv.play!(context); } };
export const UnmountDuringResponse: Story = { parameters: { lifecycleControl: true, chat: waiting }, async play(context) {
  await AwaitingResponse.play!(context);
  await context.userEvent.click(context.canvas.getByRole('button', { name: 'Unmount panel' }));
  await waitFor(() => expect(network.activeStreams).toBe(0));
  await context.userEvent.click(context.canvas.getByRole('button', { name: 'Mount panel' }));
  network.emit(answerEvents());
  await expect(await context.canvas.findByText(label('assistantGreeting'))).toBeVisible();
  await expect(context.canvas.queryByRole('button', { name: label('feedbackGood') })).not.toBeInTheDocument();
  await expect(input(context)).toBeEnabled();
} };


export const ResumeAfterRemount: Story = { parameters: { lifecycleControl: true }, async play(context) {
  await complete(context);
  const id = chatRequest.mock.calls[0][0].conversation_id;
  await context.userEvent.click(context.canvas.getByRole('button', { name: 'Unmount panel' }));
  await context.userEvent.click(context.canvas.getByRole('button', { name: 'Mount panel' }));
  await context.canvas.findByRole('button', { name: label('feedbackGood') });
  await expect(context.canvas.getByText(english() ? englishQuestion : question)).toBeVisible();
  await send(context, english() ? 'Explain that with another example.' : '別の具体例でも説明してください。');
  await waitFor(() => expect(chatRequest).toHaveBeenCalledTimes(2));
  await expect(chatRequest.mock.calls[1][0].conversation_id).toBe(id);
  await expect(chatRequest.mock.calls[1][0].resume_conversation).toBe(true);
} };
export const AutomaticConversationContinuity: Story = { async play(context) {
  await complete(context);
  await expect(context.canvas.queryByRole('button', { name: label('myConversations') })).not.toBeInTheDocument();
  await expect(context.canvas.queryByRole('button', { name: label('newConsultation') })).not.toBeInTheDocument();
  await send(context, english() ? 'Explain with an example.' : '具体例を教えてください。');
  await waitFor(() => expect(chatRequest).toHaveBeenCalledTimes(2));
  await expect(chatRequest.mock.calls[1][0].conversation_id).toBe(chatRequest.mock.calls[0][0].conversation_id);
} };
export const AutomaticConversationContinuityEnglishMobile: Story = { ...AutomaticConversationContinuity,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
