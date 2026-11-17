import { createContext, useContext, memo, useId, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import { useTranslation } from 'react-i18next';
import katex from 'katex';
import { parseMessageContent, type MessageContentNode } from '@/lib/chat/parseMessageContent';
import { protectedTextRanges, type ChatAnswer, type ChatSource } from '@videoq/trpc/chat';
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

const InlineContext = createContext<{
  nodes: Map<string, Exclude<MessageContentNode, { type: 'text' }>>;
  sources: Map<number, ChatSource>;
  navigate: MessageBodyProps['onVideoNavigate'];
} | null>(null);

const markdownComponents = {
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
  a: function InlineLink({ children, href }: { children?: React.ReactNode; href?: string }) {
    const context = useContext(InlineContext)!;
    const node = href?.startsWith('#') ? context.nodes.get(href.slice(1)) : undefined;
    if (!node) return <span>{children}</span>;
    if (node.type === 'math') return <MathExpression tex={node.value} display={node.display} />;
    const citations = node.ids.map(id => context.sources.get(id))
      .filter((source): source is ChatSource => Boolean(source && formatTimeRange(source.start_time, source.end_time)));
    return <CitationGroup sources={citations} onVideoNavigate={context.navigate} />;
  },
};

function escapeHtmlOutsideCode(text: string) {
  let end = 0;
  let result = '';
  for (const range of protectedTextRanges(text)) {
    result += text.slice(end, range.start).replace(/</g, '&lt;') + text.slice(range.start, range.end);
    end = range.end;
  }
  return result + text.slice(end).replace(/</g, '&lt;');
}

export function MessageBody({ answer, onVideoNavigate }: MessageBodyProps) {
  const { segments, sources } = answer;
  const citationMap = useMemo(() => new Map(sources.map((citation) => [citation.id, citation])), [sources]);
  const nodes = useMemo(() => parseMessageContent(segments), [segments]);

  // Keep structured citations and the existing TeX parser inside one Markdown
  // document, so emphasis and lists can span answer segments.
  let prefix = 'videoq-inline-';
  const rawText = segments.map(segment => segment.text).join('');
  while (rawText.includes(prefix)) prefix += '-';
  const inlineNodes = new Map<string, Exclude<MessageContentNode, { type: 'text' }>>(nodes.flatMap((node, index) =>
    node.type === 'text' ? [] : [[`${prefix}${index}`, node] as const]));
  const markdown = nodes.map((node, index) => node.type === 'text'
    ? escapeHtmlOutsideCode(node.value) : `[${prefix}${index}](#${prefix}${index})`).join('');

  return (
    <div className="text-std-17N-170 text-solid-gray-800 [overflow-wrap:anywhere] [&_p]:my-2 [&_p]:whitespace-pre-wrap [&_h1]:my-3 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:my-2 [&_h3]:font-bold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:border-solid-gray-200 [&_blockquote]:pl-4 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:bg-solid-gray-50 [&_pre]:p-3 [&_code]:whitespace-pre-wrap [&_code]:font-mono [&_table]:my-3 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:p-2 [&_td]:border [&_td]:p-2">
      <InlineContext.Provider value={{ nodes: inlineNodes, sources: citationMap, navigate: onVideoNavigate }}>
        <Markdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={markdownComponents}>
          {markdown}
        </Markdown>
      </InlineContext.Provider>
    </div>
  );
}
