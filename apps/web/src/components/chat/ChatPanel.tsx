import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { timeStringToSeconds } from '@/lib/utils/video';
import { cn } from '@/lib/digital-agency/cn';
import { useChatMessages } from '@/hooks/useChatMessages';
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

type PanelTab = 'chat' | 'history';

export function ChatPanel(props: ChatPanelProps) {
  // Cached route transitions can reuse this component. Keep all chat state and
  // pending requests inside the course/access-route boundary, not the parent.
  return <ChatPanelSession key={JSON.stringify([props.courseId, props.shareToken])} {...props} />;
}

function ChatPanelSession({
  courseId,
  onVideoPlay,
  shareToken,
  className,
  showHistory = true,
  suggestedQuestions,
  sendSuggestedQuestions = false,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PanelTab>('chat');

  const {
    messages,
    input,
    setInput,
    isLoading,
    feedbackUpdatingIds,
    messagesContainerRef,
    handleMessagesScroll,
    handleSend,
    handleKeyPress,
    handleFeedback,
  } = useChatMessages({ courseId, shareToken });

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
        {showTabs && (
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => setTab('chat')}
              aria-pressed={tab === 'chat'}
              className={`text-dns-14B-120 pb-1 transition-colors ${
                tab === 'chat'
                  ? 'text-key-900 border-b-2 border-key-900'
                  : 'text-solid-gray-600 hover:text-solid-gray-700'
              }`}
            >
              {t('chat.newConsultation')}
            </button>
            <button
              type="button"
              onClick={() => setTab('history')}
              aria-pressed={tab === 'history'}
              className={`text-dns-14B-120 pb-1 transition-colors ${
                tab === 'history'
                  ? 'text-key-900 border-b-2 border-key-900'
                  : 'text-solid-gray-600 hover:text-solid-gray-700'
              }`}
            >
              {t('chat.history')}
            </button>
          </div>
        )}
      </div>

      {tab === 'history' ? (
        <ChatHistoryView
          history={history}
          historyLoading={historyLoading}
          historyError={historyError}
          isExportingHistoryCsv={isExportingHistoryCsv}
          onExportHistoryCsv={exportHistoryCsv}
          onVideoNavigate={navigateToVideo}
        />
      ) : (
        <>
          <ChatMessagesView
            messages={messages}
            isLoading={isLoading}
            feedbackUpdatingIds={feedbackUpdatingIds}
            messagesContainerRef={messagesContainerRef}
            onScroll={handleMessagesScroll}
            onVideoNavigate={navigateToVideo}
            onFeedback={handleFeedback}
          />
          {suggestedQuestions && suggestedQuestions.length > 0 ? (
            <div
              className="flex shrink-0 flex-wrap gap-2 px-4 pb-3"
              role="group"
              aria-label={t('chat.suggestedQuestions')}
            >
              {suggestedQuestions.map((question) => (
                <Button
                  key={question}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isLoading}
                  className="h-auto whitespace-normal py-1.5 text-left leading-snug text-balance [word-break:auto-phrase]"
                  onClick={() => {
                    if (sendSuggestedQuestions) void handleSend(question);
                    else setInput(question);
                  }}
                >
                  {question}
                </Button>
              ))}
            </div>
          ) : null}
          <ChatComposer
            input={input}
            isLoading={isLoading}
            onInputChange={setInput}
            onKeyDown={handleKeyPress}
            onSend={handleSend}
          />
        </>
      )}
    </div>
  );
}
