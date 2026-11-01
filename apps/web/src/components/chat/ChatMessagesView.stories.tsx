import { useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import i18n from '@/i18n/config';
import { applyChatFeedback, getNextChatFeedback } from '@/lib/chatFeedback';
import { Button } from '@/components/ui/button';
import { ChatMessagesView } from './ChatMessagesView';
import { citations, longAnswer, mathAnswer, searching } from '../../../.storybook/fixtures/chat';
import { conversation, englishAnswerData, englishQuestion, longConversation } from '../../../.storybook/fixtures/chatHistory';

type MessagesExampleProps = Omit<ComponentProps<typeof ChatMessagesView>, 'messagesContainerRef' | 'messagesEndRef'> & {
  height: number;
  showScrollControls: boolean;
};

function MessagesExample({ height, showScrollControls, ...props }: MessagesExampleProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState(props.messages);
  const { i18n: locale } = useTranslation();
  const english = locale.language.startsWith('en');

  return (
    <div style={{ maxWidth: 800 }}>
      <div data-testid="messages-frame" className="flex flex-col border border-solid-gray-200 bg-white" style={{ height }}>
        <ChatMessagesView
          {...props}
          messages={messages}
          messagesContainerRef={messagesContainerRef}
          messagesEndRef={messagesEndRef}
          onFeedback={async (id, value) => {
            await props.onFeedback(id, value);
            setMessages(current => applyChatFeedback(current, id, getNextChatFeedback(
              current.find(message => message.chatLogId === id)?.feedback,
              value,
            )));
          }}
        />
      </div>
      {showScrollControls && (
        <div className="mt-2 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => messagesContainerRef.current?.scrollTo({ top: 0, behavior: 'instant' })}>
            {english ? 'First message' : '先頭へ'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => messagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' })}>
            {english ? 'Latest message' : '末尾へ'}
          </Button>
        </div>
      )}
    </div>
  );
}

const meta = {
  title: 'Chat/ChatMessagesView',
  component: MessagesExample,
  subcomponents: { ChatMessagesView },
  render: args => <MessagesExample key={JSON.stringify(args.messages)} {...args} />,
  parameters: {
    docs: { description: { component: '固定高の会話欄。refとフィードバック状態は各ストーリー内で作成します。引用・評価操作はActionsに記録し、APIへ送信しません。' } },
  },
  args: {
    messages: conversation,
    isLoading: false,
    feedbackUpdatingIds: new Set<number>(),
    height: 600,
    showScrollControls: false,
    onScroll: fn(),
    onVideoNavigate: fn(),
    onFeedback: fn().mockResolvedValue(undefined),
  },
  argTypes: { height: { control: { type: 'range', min: 240, max: 900, step: 20 } } },
} satisfies Meta<typeof MessagesExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { messages: [] } };
export const Conversation: Story = {};

export const LongConversation: Story = {
  args: { messages: longConversation, showScrollControls: true, height: 360 },
  globals: { locale: 'ja' },
  play: async ({ canvas, userEvent, args }) => {
    const scroller = canvas.getByTestId('messages-frame').querySelector<HTMLDivElement>('.overflow-y-auto')!;
    await expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    await userEvent.click(canvas.getByRole('button', { name: '末尾へ' }));
    // scrollIntoView reveals the end marker, leaving the container's bottom padding below it.
    await waitFor(() => expect(scroller.lastElementChild!.getBoundingClientRect().bottom).toBeLessThanOrEqual(scroller.getBoundingClientRect().bottom));
    await expect(scroller.scrollTop).toBeGreaterThan(0);
    await waitFor(() => expect(args.onScroll).toHaveBeenCalled());
    await userEvent.click(canvas.getByRole('button', { name: '先頭へ' }));
    await waitFor(() => expect(scroller.scrollTop).toBe(0));
  },
};

export const AwaitingLastResponse: Story = {
  args: {
    messages: [
      { role: 'user', content: '前の回答は空のまま終了しました。' },
      { role: 'assistant', answer: { segments: [{ text: '', sourceIds: [] }], sources: [] } },
      { role: 'user', content: 'もう一度、回転行列について教えてください。' },
      { role: 'assistant', answer: { segments: [{ text: '', sourceIds: [] }], sources: [] } },
    ],
    isLoading: true,
  },
  play: async ({ canvas }) => {
    const indicators = canvas.getAllByRole('status');
    await expect(indicators).toHaveLength(1);
    await expect(indicators[0]).toHaveTextContent(i18n.t('chat.generating'));
    const bubbles = canvas.getAllByText(i18n.t('chat.answerLabel'));
    await expect(bubbles.at(-1)!.parentElement).toContainElement(indicators[0]);
  },
};

export const SearchingLastResponse: Story = {
  args: {
    messages: [...conversation.slice(0, 2), { role: 'user', content: 'さらに詳しい例はありますか？' }, { role: 'assistant', answer: { segments: [{ text: '', sourceIds: [] }], sources: [] }, progress: searching }],
    isLoading: true,
  },
  play: async ({ canvas, userEvent }) => {
    const toggle = canvas.getByRole('button', { name: `${i18n.t('chat.progress.checkingVideos')}。${i18n.t('chat.progress.details')}` });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByText(searching.searches[1].query)).toBeVisible();
  },
};

export const StreamingLastResponse: Story = {
  args: {
    messages: [...conversation.slice(0, 3), { role: 'assistant', answer: { segments: [{ text: '回転角を使って行列の各要素を', sourceIds: [] }], sources: [] }, progress: { ...searching, phase: 'answering' } }],
    isLoading: true,
  },
};
export const LongTextAndMath: Story = {
  args: { messages: [...conversation.slice(0, 1), { role: 'assistant', answer: { segments: [{ text: `${longAnswer}\n\n${mathAnswer}`, sourceIds: (citations).map(source => source.id) }], sources: citations }, chatLogId: 101 }], showScrollControls: true },
};
export const FeedbackUpdating: Story = {
  args: { feedbackUpdatingIds: new Set([102]) },
  play: async ({ canvas, userEvent, args }) => {
    const good = canvas.getAllByRole('button', { name: i18n.t('chat.feedbackGood') });
    const bad = canvas.getAllByRole('button', { name: i18n.t('chat.feedbackBad') });
    await expect(good[0]).toBeEnabled();
    await expect(bad[0]).toBeEnabled();
    await expect(good[1]).toBeDisabled();
    await expect(bad[1]).toBeDisabled();
    const citation = canvas.getAllByRole('button', { name: `${citations[0].title} ${citations[0].start_time}` }).at(-1)!;
    citation.focus();
    await userEvent.tab();
    await expect(good[1]).not.toHaveFocus();
    await expect(bad[1]).not.toHaveFocus();
    await expect(args.onFeedback).not.toHaveBeenCalled();
  },
};
export const KeyboardCitationsAndFeedback: Story = {
  args: { messages: conversation.slice(0, 2) },
  play: async ({ canvas, userEvent, args }) => {
    const citation = canvas.getByRole('button', { name: `${citations[0].title} ${citations[0].start_time}` });
    citation.focus();
    await expect(citation).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onVideoNavigate).toHaveBeenCalledWith(7, '00:21:37');
    await userEvent.tab();
    await userEvent.tab();
    const good = canvas.getByRole('button', { name: i18n.t('chat.feedbackGood') });
    await expect(good).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(args.onFeedback).toHaveBeenCalledWith(101, 'good');
    await expect(good).toHaveClass('text-solid-gray-420');
    await userEvent.tab();
    const bad = canvas.getByRole('button', { name: i18n.t('chat.feedbackBad') });
    await expect(bad).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onFeedback).toHaveBeenCalledWith(101, 'bad');
    await expect(bad).toHaveClass('text-error-1');
  },
};
export const JapaneseMobile: Story = {
  args: { height: 640 },
  globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } },
};
export const EnglishMobile: Story = {
  args: {
    messages: [{ role: 'user', content: englishQuestion }, { role: 'assistant', answer: englishAnswerData, chatLogId: 101 }],
    height: 640,
  },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
