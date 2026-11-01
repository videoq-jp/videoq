import { BookOpen, Download, ThumbsDown, ThumbsUp, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatHistoryItem } from '@/lib/api';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { MessageBody } from '@/components/chat/MessageBody';
import { Button } from '@/components/ui/button';
import { ChipLabel } from '@/components/ui/chip-label';
import { Divider } from '@/components/ui/divider';

interface ChatHistoryViewProps {
  history: ChatHistoryItem[] | null;
  historyLoading: boolean;
  historyError?: { message: string } | null;
  isExportingHistoryCsv: boolean;
  onExportHistoryCsv: () => void;
  onVideoNavigate: (videoId: number, startTime: string) => void;
}

function HistoryItem({
  item,
  onVideoNavigate,
}: {
  item: ChatHistoryItem;
  onVideoNavigate: (videoId: number, startTime: string) => void;
}) {
  const { t, i18n } = useTranslation();

  return (
    <div className="space-y-3">
      <div className="flex justify-center">
        <ChipLabel variant="filled-1" color="gray" className="min-h-0 text-oln-14N-100">
          {new Date(item.created_at).toLocaleString(i18n.language)}
        </ChipLabel>
      </div>

      <div className="flex flex-col items-end">
        <div className="max-w-[90%] border border-solid-gray-420 bg-solid-gray-50 px-4 py-3 text-std-16N-170 text-solid-gray-800">
          <div className="mb-1.5 flex flex-wrap items-center justify-end gap-x-2 text-dns-14N-130 text-solid-gray-600">
            <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-bold text-solid-gray-800">
              {item.asked_by?.username ?? t('chat.sharedLinkUser')}
            </span>
            {item.asked_by ? <span className="break-all">{item.asked_by.email}</span> : null}
          </div>
          <div>{item.question}</div>
        </div>
      </div>

      <div className="flex flex-col items-start">
        <div className="max-w-[90%] space-y-2 border border-solid-gray-420 border-l-4 border-l-key-900 bg-white p-4 text-std-16N-170">
          <div className="flex items-center gap-2 text-dns-14B-120 font-bold text-key-900">
            <BookOpen className="h-3.5 w-3.5" />
            {t('chat.answerLabel')}
          </div>
          <MessageBody
            answer={item.answer}
            onVideoNavigate={onVideoNavigate}
          />
          {item.feedback && (
            <div className={`flex items-center gap-1 pt-1 text-dns-14B-120 ${item.feedback === 'good' ? 'text-key-900' : 'text-error-1'}`}>
              {item.feedback === 'good' ? <ThumbsUp className="w-3 h-3" /> : <ThumbsDown className="w-3 h-3" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChatHistoryView({
  history,
  historyLoading,
  historyError,
  isExportingHistoryCsv,
  onExportHistoryCsv,
  onVideoNavigate,
}: ChatHistoryViewProps) {
  const { t } = useTranslation();
  const historyCount = history?.length ?? 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {historyCount > 0 && (
        <div className="flex justify-end px-4 pt-3 shrink-0">
          <Button
            type="button"
            variant="text"
            size="xs"
            onClick={() => onExportHistoryCsv()}
            disabled={isExportingHistoryCsv}
          >
            {isExportingHistoryCsv ? <InlineSpinner className="w-3 h-3 mr-1.5" /> : <Download className="w-3 h-3 mr-1.5" />}
            {t('chat.exportCsvShort', 'CSV')}
          </Button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {historyLoading && (
          <LoadingSpinner />
        )}
        {!historyLoading && historyError && <ErrorMessage message={historyError.message} />}
        {!historyLoading && !historyError && historyCount === 0 && (
          <p className="text-std-16N-170 text-solid-gray-600 text-center py-8">{t('chat.historyEmpty')}</p>
        )}
        {history?.map((item, i) => (
          <div key={item.id}>
            {i > 0 && <Divider className="mb-6" />}
            <HistoryItem item={item} onVideoNavigate={onVideoNavigate} />
          </div>
        ))}
      </div>
    </div>
  );
}
