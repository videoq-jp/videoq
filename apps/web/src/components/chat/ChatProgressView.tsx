import { useId, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { useTranslation } from 'react-i18next';
import type { ChatProgress } from '@/lib/chatProgress';

export function ChatProgressView({ progress, waitingForAnswer }: {
  progress: ChatProgress;
  waitingForAnswer: boolean;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const { phase, searches, tools = [] } = progress;
  // Network completion can precede the first typewriter tick. Keep the waiting
  // state until answer text is actually on screen, and group the search loop.
  const pending = waitingForAnswer && phase !== 'error';
  const hasActivity = searches.length > 0 || tools.length > 0;
  if (!pending && !hasActivity) return null;

  const queries = [...new Set(searches.map((search) => search.query))];
  const runningTools = tools.filter(tool => tool.status === 'running');
  const pendingLabel = phase === 'searching'
    ? runningTools.length > 0
      ? [...new Set(runningTools.map(tool => t(`chat.progress.tools.${tool.tool}.running`)))].join(' / ')
      : t('chat.progress.checkingVideos')
    : t(`chat.progress.${phase === 'complete' ? 'answering' : phase === 'error' ? 'interrupted' : phase}`);
  const label = pending ? pendingLabel
    : phase === 'error' ? t('chat.progress.interrupted')
      : tools.length > 0 ? t('chat.progress.usedTools', { count: tools.length }) : t('chat.progress.searched');
  const summary = <>
    {pending ? <InlineSpinner /> : <Search aria-hidden="true" className="h-6 w-6 shrink-0" />}
    <span className="min-w-0 line-clamp-2 text-left">{label}</span>
  </>;

  return (
    <div className="min-w-0 space-y-2 text-dns-14N-130 text-solid-gray-600">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {label}
      </p>
      {/* Keep the collapsed row the same height through every search phase. */}
      <button
        type="button"
        disabled={!hasActivity}
        aria-label={`${label}。${t('chat.progress.details')}`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-10 w-full items-center gap-2 rounded-4 enabled:hover:text-key-900 app-focus"
      >
        {summary}
        <ChevronDown aria-hidden="true" className={`ml-auto h-4 w-4 shrink-0 ${hasActivity ? '' : 'invisible'} ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {hasActivity && (
        <div id={detailsId} hidden={!expanded} className="space-y-2 border-l border-solid-gray-200 pl-3 text-solid-gray-800">
          {tools.length > 0 && (
            <ol className="space-y-2">
              {tools.map(tool => (
                <li key={tool.id} className="[overflow-wrap:anywhere]">
                  <span>{t(`chat.progress.tools.${tool.tool}.name`)}</span>
                  {' — '}<span>{t(`chat.progress.toolStatus.${tool.status}`)}</span>
                </li>
              ))}
            </ol>
          )}
          {queries.length > 0 && (
            <ul className="space-y-2">
              {queries.map(query => <li key={query} className="[overflow-wrap:anywhere]">{query}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
