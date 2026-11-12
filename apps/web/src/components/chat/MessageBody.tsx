import { Fragment, memo, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import katex from 'katex';
import { parseMessageContent } from '@/lib/chat/parseMessageContent';
import type { ChatAnswer, ChatSource } from '@videoq/trpc/chat';
import { linkVariants } from '@/components/ui/link';
import { cn } from '@/lib/digital-agency/cn';
import 'katex/dist/katex.min.css';

interface MessageBodyProps {
  answer: ChatAnswer;
  onVideoNavigate: (videoId: number, startTime: string) => void;
}

function formatInlineTime(time: string | null | undefined) {
  if (!time) return '';
  const main = time.split(',')[0];
  return main.replace(/^00:/, '').replace(/^0(\d:)/, '$1');
}

function formatTimeRange(startTime: string | null | undefined, endTime: string | null | undefined) {
  const start = formatInlineTime(startTime);
  const end = formatInlineTime(endTime);
  if (start && end && start !== end) return `${start}-${end}`;
  return start || end;
}

const MathExpression = memo(function MathExpression({ tex, display }: { tex: string; display: boolean }) {
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    trust: false,
  });
  return (
    <span
      className={cn('whitespace-normal', display && 'my-3 block overflow-x-auto text-center')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

function CitationGroup({ sources, onVideoNavigate }: {
  sources: ChatSource[];
  onVideoNavigate: MessageBodyProps['onVideoNavigate'];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const collapsible = sources.length > 3;
  const links = sources.map(source => (
    <button
      key={source.id}
      type="button"
      onClick={() => onVideoNavigate(source.video_id, source.start_time ?? '')}
      className={cn(linkVariants(), 'inline text-left')}
      title={`${source.title} ${source.start_time}`}
      aria-label={`${source.title} ${source.start_time}`}
    >
      {` (${formatTimeRange(source.start_time, source.end_time)})`}
    </button>
  ));
  if (!collapsible) return <>{links}</>;
  return (
    <span>
      {' '}
      <button
        type="button"
        className={cn(linkVariants(), 'inline text-left')}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded(value => !value)}
      >
        {t('chat.citationGroup', { count: sources.length })}
      </button>
      <span
        id={panelId}
        hidden={!expanded}
        className={expanded ? 'my-2 flex flex-wrap gap-x-3 gap-y-1 rounded border border-solid-gray-200 p-2' : undefined}
      >
        {links}
      </span>
    </span>
  );
}

export function MessageBody({ answer, onVideoNavigate }: MessageBodyProps) {
  const { segments, sources } = answer;
  const citationMap = useMemo(() => new Map(sources.map((citation) => [citation.id, citation])), [sources]);
  const nodes = useMemo(() => parseMessageContent(segments), [segments]);

  return (
    <div className="text-std-17N-170 text-solid-gray-800 whitespace-pre-wrap">
      {nodes.map((node, i) => {
        if (node.type === 'text') {
          return <Fragment key={`text-${i}`}>{node.value}</Fragment>;
        }

        if (node.type === 'math') {
          return (
            <MathExpression
              key={`math-${i}`}
              tex={node.value}
              display={node.display}
            />
          );
        }

        const citations = node.ids.map(id => citationMap.get(id))
          .filter((source): source is ChatSource => Boolean(source && formatTimeRange(source.start_time, source.end_time)));
        return (
          <CitationGroup key={`refs-${i}`} sources={citations} onVideoNavigate={onVideoNavigate} />
        );
      })}
    </div>
  );
}
