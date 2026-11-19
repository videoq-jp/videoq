import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/digital-agency/cn';
import { Button } from '@/components/ui/button';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { InlineLoading } from '@/components/common/InlineLoading';
import { ChatComposer } from './ChatComposer';
import type { ChatPanelProps } from './ChatPanel';
type PanelTab = 'chat' | 'history';

export function ChatPanelFrame({ courseId, shareToken, showTitle = true, showHistory = true, className, tab = 'chat', onTabChange, children }: ChatPanelProps & {
  tab?: PanelTab; onTabChange?: (tab: PanelTab) => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const showTabs = !!courseId && !shareToken && showHistory;
  return <div data-chat-frame className={cn('flex min-h-0 flex-col overflow-hidden border border-solid-gray-420 bg-white', className ?? 'h-[500px] lg:h-[600px]')}>
      {(showTitle || showTabs) && <div className="px-4 py-3 border-b border-solid-gray-200 shrink-0 flex flex-wrap items-center justify-between gap-4">
        {showTitle && <Heading size="18" className="shrink-0">
          <HeadingTitle level={shareToken ? 'h3' : 'h2'}>{t('chat.title')}</HeadingTitle>
        </Heading>}
        {showTabs && <div className="flex w-full flex-wrap gap-4 text-std-17N-170">
          <button type="button" disabled={!onTabChange} onClick={() => onTabChange?.('chat')} aria-pressed={tab === 'chat'}
            className={cn('app-focus min-h-11 rounded-4 px-2 text-oln-16N-100 hover:underline disabled:text-solid-gray-300 disabled:no-underline', tab === 'chat' ? 'font-bold text-key-900 underline underline-offset-4' : 'text-solid-gray-600')}>
            {t('chat.currentConversation')}
          </button>
          <button type="button" disabled={!onTabChange} onClick={() => onTabChange?.('history')} aria-pressed={tab === 'history'}
            className={cn('app-focus min-h-11 rounded-4 px-2 text-oln-16N-100 hover:underline disabled:text-solid-gray-300 disabled:no-underline', tab === 'history' ? 'font-bold text-key-900 underline underline-offset-4' : 'text-solid-gray-600')}>
            {t('chat.history')}
          </button>
        </div>}
      </div>}

    {children}
  </div>;
}

export function ChatLoadingContent({ suggestedQuestions }: { suggestedQuestions?: string[] }) {
  const { t } = useTranslation();
  return <>
    <div className="flex min-h-0 flex-1 items-center justify-center p-4" aria-busy="true">
      <InlineLoading message={t('chat.restoringConversation')} />
    </div>
    {!!suggestedQuestions?.length && <div className="min-h-0 shrink overflow-y-auto px-4 pb-2"><ChatSuggestedQuestions questions={suggestedQuestions} disabled /></div>}
    <ChatComposer input="" isLoading={false} disabled onInputChange={() => {}} onKeyDown={() => {}} onSend={async () => {}} />
  </>;
}

/** Render the real frame and composer before identity or conversation data arrives. */
export function ChatPanelLoading(props: ChatPanelProps) {
  return <ChatPanelFrame {...props}><ChatLoadingContent suggestedQuestions={props.suggestedQuestions} /></ChatPanelFrame>;
}

export function ChatSuggestedQuestions({ questions, disabled, onSelect }: {
  questions: string[]; disabled: boolean; onSelect?: (question: string) => void;
}) {
  const { t } = useTranslation();
  return <div className="flex max-h-[20dvh] gap-2 overflow-x-auto sm:flex-wrap sm:overflow-y-auto" role="group" aria-label={t('chat.suggestedQuestions')}>
    {questions.map(question => <Button key={question} type="button" variant="outline" size="sm" disabled={disabled}
      className="h-auto min-h-11 max-w-[85%] shrink-0 whitespace-normal py-2 text-left text-std-16B-170 sm:max-w-full sm:shrink"
      onClick={() => onSelect?.(question)}>{question}</Button>)}
  </div>;
}
