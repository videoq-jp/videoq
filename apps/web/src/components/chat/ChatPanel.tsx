import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { timeStringToSeconds } from '@/lib/utils/video';
import { cn } from '@/lib/digital-agency/cn';
import { useChatMessages } from '@/hooks/useChatMessages';
import { useChatConversations } from '@/hooks/useChatConversations';
import { useAuthSession } from '@/lib/authSession';
import type { Message } from '@/hooks/useChatMessages';
import { useChatHistory } from '@/hooks/useChatHistory';
import { ChatComposer } from '@/components/chat/ChatComposer';
import { ChatHistoryView } from '@/components/chat/ChatHistoryView';
import { ChatMessagesView } from '@/components/chat/ChatMessagesView';
import { Button } from '@/components/ui/button';
import { Heading, HeadingTitle } from '@/components/ui/heading';

interface ChatPanelProps {
  courseId?: number;
  onVideoPlay?: (videoId: number, startTime: string) => void;
  shareToken?: string;
  className?: string;
  showHistory?: boolean;
  suggestedQuestions?: string[];
  /** Send a suggested question on click instead of only filling the composer. */
  sendSuggestedQuestions?: boolean;
}

type PanelTab = 'chat' | 'history' | 'conversations';

export function ChatPanel(props: ChatPanelProps) {
  // Cached route transitions can reuse this component. Keep all chat state and
  // pending requests inside the course/access-route boundary, not the parent.
  const session = useAuthSession();
  const { t } = useTranslation();
  if (session.isPending) return <p role="status">{t("chat.restoringConversation")}</p>;
  const identity = session.data?.user.id ?? 'visitor';
  const scope = JSON.stringify([identity, props.courseId, props.shareToken]);
  return <ChatPanelSession key={scope} {...props} storageKey={`videoq:conversations:v1:${scope}`} />;
}

function ChatPanelSession({
  courseId,
  onVideoPlay,
  shareToken,
  className,
  showHistory = true,
  suggestedQuestions,
  sendSuggestedQuestions = false,
  storageKey,
}: ChatPanelProps & { storageKey: string }) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<PanelTab>('chat');

  const conversations = useChatConversations({ courseId, shareToken, storageKey, showList: tab === 'conversations' });

  const {
    history,
    historyLoading,
    historyError,
    exportHistoryCsv,
    isExportingHistoryCsv,
  } = useChatHistory({
    courseId,
    shareToken,
    enabled: tab === 'history',
  });

  const navigateToVideo = (videoId: number, startTime: string) => {
    if (onVideoPlay) {
      onVideoPlay(videoId, startTime);
      return;
    }

    const seconds = timeStringToSeconds(startTime);
    window.open(`/videos/${videoId}?t=${seconds}`, '_blank');
  };

  const showTabs = !!courseId && !shareToken && showHistory;

  const containerClass = cn(
    'flex min-h-0 flex-col overflow-hidden border border-solid-gray-420 bg-white',
    className ?? 'h-[500px] lg:h-[600px]',
  );

  return (
    <div className={containerClass}>
      <div className="px-4 py-3 border-b border-solid-gray-200 shrink-0 flex flex-wrap items-center justify-between gap-4">
        <Heading size="18" className="shrink-0">
          <HeadingTitle level={shareToken ? 'h3' : 'h2'}>{t('chat.title')}</HeadingTitle>
        </Heading>
        <Button type="button" variant="outline" size="sm" onClick={() => { conversations.startNew(); setTab('chat'); }}>
          {t('chat.newConsultation')}
        </Button>
        <div className="flex w-full flex-wrap gap-4 text-sm">
          <button type="button" onClick={() => setTab('chat')} aria-pressed={tab === 'chat'}
            className={tab === 'chat' ? 'font-bold text-key-900 underline underline-offset-4' : 'text-solid-gray-600'}>
            {t('chat.currentConversation')}
          </button>
          <button type="button" aria-pressed={tab === 'conversations'} onClick={() => setTab('conversations')}
            className={tab === 'conversations' ? 'font-bold text-key-900 underline underline-offset-4' : 'text-solid-gray-600'}>
            {t('chat.myConversations')}
          </button>
          {showTabs && <button type="button" onClick={() => setTab('history')} aria-pressed={tab === 'history'}
            className={tab === 'history' ? 'font-bold text-key-900 underline underline-offset-4' : 'text-solid-gray-600'}>
            {t('chat.history')}
          </button>}
        </div>
      </div>

      {tab === 'history' && (
        <ChatHistoryView
          history={history}
          historyLoading={historyLoading}
          historyError={historyError}
          isExportingHistoryCsv={isExportingHistoryCsv}
          onExportHistoryCsv={exportHistoryCsv}
          onVideoNavigate={navigateToVideo}
        />
      )}
      {tab === 'conversations' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-sm text-solid-gray-600">{t('chat.conversationRetention')}</p>
          {conversations.list.isPending && <p role="status">{t('chat.loadingConversations')}</p>}
          {conversations.list.error && <div role="alert">{t('chat.loadConversationsError')} <Button onClick={() => void conversations.list.refetch()}>{t('chat.retry')}</Button></div>}
          {conversations.deleteError && <p role="alert">{t('chat.deleteConversationError')}</p>}
          {conversations.list.data?.pages.flatMap(page => page.items).map(item => (
            <div key={item.id} className="flex items-center gap-3 border-b border-solid-gray-200 pb-3">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { conversations.select(item.id); setTab('chat'); }}>
                <span className="block break-words">{item.title}</span>
                <time className="text-sm text-solid-gray-600" dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString(i18n.language)}</time>
              </button>
              <Button type="button" variant="outline" size="sm" disabled={conversations.deleting || item.isGenerating}
                aria-label={t('chat.deleteNamedConversation', { title: item.title })} onClick={() => void conversations.remove(item.id).catch(() => {})}>
                {t('chat.deleteConversation')}
              </Button>
            </div>
          ))}
          {conversations.list.data?.pages[0]?.items.length === 0 && <p>{t('chat.historyEmpty')}</p>}
          {conversations.list.hasNextPage && <Button disabled={conversations.list.isFetchingNextPage} onClick={() => void conversations.list.fetchNextPage()}>{t('chat.loadMoreConversations')}</Button>}
        </div>
      )}
      <div className={tab === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        {conversations.restoring ? <p role="status" className="p-4">{t('chat.restoringConversation')}</p>
          : conversations.restoreError ? <div role="alert" className="p-4 space-y-3">
            <p>{t('chat.restoreConversationError')}</p>
            <Button onClick={() => void conversations.detail.refetch()}>{t('chat.retry')}</Button>
            <Button onClick={conversations.startNew}>{t('chat.newConsultation')}</Button>
          </div> : <ActiveChat key={conversations.selected.id} visible={tab === 'chat'}
            courseId={courseId} shareToken={shareToken} conversationId={conversations.selected.id}
            initialMessages={conversations.messages} existingConversation={conversations.selected.restore} remoteBusy={conversations.remoteBusy}
            onSend={conversations.remember} onAnswer={conversations.refresh}
            onVideoNavigate={navigateToVideo} suggestedQuestions={suggestedQuestions} sendSuggestedQuestions={sendSuggestedQuestions}
            hasEarlier={!!conversations.detail.hasNextPage} loadingEarlier={conversations.detail.isFetchingNextPage}
            onLoadEarlier={() => conversations.detail.fetchNextPage({ throwOnError: true })}
            earlierError={conversations.detail.isFetchNextPageError} />}
      </div>
    </div>
  );
}

function ActiveChat({ initialMessages, remoteBusy, visible, onVideoNavigate, suggestedQuestions, sendSuggestedQuestions,
  hasEarlier, loadingEarlier, onLoadEarlier, earlierError, ...options }: {
    courseId?: number; shareToken?: string; conversationId: string; initialMessages: Message[]; existingConversation: boolean;
    remoteBusy: boolean; visible: boolean; onSend: () => void; onAnswer: () => void;
    onVideoNavigate: (videoId: number, startTime: string) => void;
    suggestedQuestions?: string[]; sendSuggestedQuestions?: boolean;
    hasEarlier: boolean; loadingEarlier: boolean; earlierError: boolean; onLoadEarlier: () => Promise<unknown>;
  }) {
  const { t } = useTranslation();
  const chat = useChatMessages({ ...options, initialMessages, visible });
  const { isLoading, setMessages } = chat;
  const olderScroll = useRef<{ height: number; top: number; count: number } | null>(null);
  const wasBusy = useRef(remoteBusy);
  const lastInitial = useRef(initialMessages);
  useEffect(() => {
    // Refetches during our own stream must not replace growing local messages.
    // Remote completion and explicitly loading older pages do update the view.
    if (!isLoading && (wasBusy.current || initialMessages.length > lastInitial.current.length)) {
      if (initialMessages.length) setMessages(initialMessages);
    }
    wasBusy.current = remoteBusy;
    lastInitial.current = initialMessages;
  }, [initialMessages, remoteBusy, isLoading, setMessages]);
  const { messages, messagesContainerRef, handleMessagesScroll } = chat;
  useLayoutEffect(() => {
    const position = olderScroll.current;
    const container = messagesContainerRef.current;
    if (position && container && messages.length > position.count) {
      container.scrollTop = position.top + container.scrollHeight - position.height;
      handleMessagesScroll();
      olderScroll.current = null;
    }
  }, [messages.length, messagesContainerRef, handleMessagesScroll]);
  const loadEarlier = () => {
    const container = messagesContainerRef.current;
    if (container) olderScroll.current = { height: container.scrollHeight, top: container.scrollTop, count: messages.length };
    void onLoadEarlier().catch(() => { olderScroll.current = null; });
  };
  const busy = chat.isLoading || remoteBusy;
  if (!visible) return null;
  return <>
    {hasEarlier && <Button disabled={loadingEarlier || busy} onClick={loadEarlier}>{t('chat.loadEarlierMessages')}</Button>}
    {earlierError && <p role="alert" className="px-4 py-2">{t("chat.loadEarlierError")}</p>}
    {remoteBusy && <p role="status" className="px-4 py-2">{t('chat.answerInProgress')}</p>}
    <ChatMessagesView messages={chat.messages} isLoading={chat.isLoading}
      feedbackUpdatingIds={chat.feedbackUpdatingIds} messagesContainerRef={chat.messagesContainerRef}
      onScroll={chat.handleMessagesScroll} onVideoNavigate={onVideoNavigate} onFeedback={chat.handleFeedback} />
    {suggestedQuestions && suggestedQuestions.length > 0 && <div className="flex shrink-0 flex-wrap gap-2 px-4 pb-3" role="group" aria-label={t('chat.suggestedQuestions')}>
      {suggestedQuestions.map(question => <Button key={question} type="button" variant="outline" size="sm" disabled={busy}
        className="h-auto whitespace-normal py-1.5 text-left leading-snug" onClick={() => {
          if (sendSuggestedQuestions) void chat.handleSend(question); else chat.setInput(question);
        }}>{question}</Button>)}
    </div>}
    <ChatComposer input={chat.input} isLoading={busy} onInputChange={chat.setInput} onKeyDown={event => { if (!remoteBusy) chat.handleKeyPress(event); }}
      onSend={() => remoteBusy ? Promise.resolve() : chat.handleSend()} />
  </>;
}
