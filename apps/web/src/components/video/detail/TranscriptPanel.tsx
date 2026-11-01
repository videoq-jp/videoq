import { useTranslation } from 'react-i18next';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import type { Video } from '@/lib/api';
import type { TranscriptSegment } from '@/lib/transcript/srt';
import { Pencil, Save, Search } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { Heading, HeadingTitle } from '@/components/ui/heading';
type MobileTab = 'transcript' | 'video';

export function TranscriptPanel({
  video,
  isMobile,
  mobileTab,
  transcriptSearch,
  onTranscriptSearchChange,
  isTranscriptEditing,
  onStartTranscriptEditing,
  onCancelTranscriptEditing,
  editedTranscript,
  onEditedTranscriptChange,
  onSaveTranscript,
  isTranscriptSaving,
  transcriptSaveError,
  filteredSegments,
  activeSegmentIdx,
  onSeek,
  isPlainTextTranscript,
}: {
  video: Video;
  isMobile: boolean;
  mobileTab: MobileTab;
  transcriptSearch: string;
  onTranscriptSearchChange: (value: string) => void;
  isTranscriptEditing: boolean;
  onStartTranscriptEditing: () => void;
  onCancelTranscriptEditing: () => void;
  editedTranscript: string;
  onEditedTranscriptChange: (value: string) => void;
  onSaveTranscript: () => void;
  isTranscriptSaving: boolean;
  transcriptSaveError: string | null;
  filteredSegments: TranscriptSegment[];
  activeSegmentIdx: number | null;
  onSeek: (seconds: number, idx: number) => void;
  isPlainTextTranscript: boolean;
}) {
  const { t } = useTranslation();
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(isTranscriptEditing);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (wasEditing.current && !isTranscriptEditing) editRef.current?.focus();
    wasEditing.current = isTranscriptEditing;
  }, [isTranscriptEditing]);
  useEffect(() => { if (transcriptSaveError) errorRef.current?.focus(); }, [transcriptSaveError]);

  return (
    <div
      className={`min-w-0 lg:col-span-4 lg:relative ${isMobile && mobileTab !== 'transcript' ? 'hidden' : ''}`}
    >
      <div className={`flex min-h-[31.25rem] flex-col border border-solid-gray-420 bg-white lg:absolute lg:inset-0 lg:min-h-0 ${isTranscriptEditing ? 'h-[70dvh] lg:h-auto' : ''}`}>
        <div className="p-4 border-b border-solid-gray-200 flex flex-col gap-3 shrink-0">
          <div className="flex justify-between items-center">
            <Heading size="18">
              <HeadingTitle level="h2">{t('videos.detail.transcriptSection')}</HeadingTitle>
            </Heading>
            {!isTranscriptEditing && (
              <Button
                ref={editRef}
                type="button"
                variant="outline"
                size="xs"
                onClick={onStartTranscriptEditing}
                disabled={!video.transcript && video.status !== 'completed'}
              >
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                {t('videos.detail.editTranscriptButton')}
              </Button>
            )}
          </div>
          {!isTranscriptEditing && (
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-solid-gray-600 w-3.5 h-3.5 z-10" />
              <Input
                type="search"
                blockSize="sm"
                value={transcriptSearch}
                onChange={(event) => onTranscriptSearchChange(event.target.value)}
                aria-label={t('videos.detail.transcriptSearchPlaceholder')}
                className="block w-full pl-9"
              />
            </div>
          )}
        </div>

        {isTranscriptEditing ? (
          <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
            <div className="flex shrink-0 flex-col gap-3 border-b border-solid-gray-200 bg-solid-gray-50 p-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={onCancelTranscriptEditing}
                  disabled={isTranscriptSaving}
                >
                  {t('videos.detail.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="solid"
                  size="xs"
                  onClick={onSaveTranscript}
                  disabled={isTranscriptSaving}
                >
                  {isTranscriptSaving ? <InlineSpinner className="h-3 w-3 mr-1.5" /> : <Save className="h-3 w-3 mr-1.5" />}
                  {isTranscriptSaving ? t('videos.detail.saving') : t('videos.detail.saveTranscriptButton')}
                </Button>
              </div>
            </div>
            {transcriptSaveError && (
              <div ref={errorRef} tabIndex={-1} className="shrink-0 p-3 border-b border-solid-gray-200 focus-visible:outline-4 focus-visible:outline-black">
                <ErrorMessage message={transcriptSaveError} />
              </div>
            )}
            <div className="min-h-0 flex-1 [&>span]:h-full">
              <Textarea
                autoFocus
                aria-label={t('videos.detail.transcriptSection')}
                value={editedTranscript}
                onChange={(event) => onEditedTranscriptChange(event.target.value)}
                disabled={isTranscriptSaving}
                spellCheck={false}
                className="h-full min-h-0 resize-none rounded-none border-0 font-mono text-dns-14N-130 leading-relaxed focus:outline-none focus:ring-0"
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            {filteredSegments.length > 0 ? (
              filteredSegments.map((segment, index) => (
                <button
                  type="button"
                  aria-current={activeSegmentIdx === index ? 'true' : undefined}
                  key={index}
                  onClick={() => onSeek(segment.seconds, index)}
                  className={`text-left focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-[-4px] flex cursor-pointer gap-4 rounded-8 p-3 transition-colors group ${
                    activeSegmentIdx === index
                      ? 'border-l-4 border-key-900 bg-blue-50'
                      : 'hover:bg-solid-gray-50'
                  }`}
                >
                  <span className="mt-0.5 h-fit shrink-0 whitespace-nowrap rounded-8 bg-blue-50 px-2 py-0.5 font-mono text-dns-14B-120 text-key-900">
                    {segment.timestamp}
                  </span>
                  <span
                    className={`min-w-0 [overflow-wrap:anywhere] text-std-16N-170 leading-relaxed ${
                      activeSegmentIdx === index
                        ? 'text-solid-gray-800 font-medium'
                        : 'text-solid-gray-700 group-hover:text-solid-gray-800'
                    }`}
                  >
                    {segment.text}
                  </span>
                </button>
              ))
            ) : isPlainTextTranscript ? (
              <div className="p-4 bg-white rounded-8">
                <p className="text-std-16N-170 text-solid-gray-700 [overflow-wrap:anywhere] whitespace-pre-wrap leading-relaxed">
                  {video.transcript}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-solid-gray-600">
                <div className="w-16 h-16 bg-solid-gray-50 border border-solid-gray-200 rounded-full flex items-center justify-center mb-4">
                  <Search className="w-8 h-8 text-solid-gray-420" />
                </div>
                <p className="text-std-16N-170 font-medium text-center px-4">
                  {transcriptSearch
                    ? t('videos.detail.transcriptNotFound')
                    : (() => {
                        const statusMsgs: Partial<Record<Video['status'], string>> = {
                          pending: t('videos.detail.transcriptStatus.pending'),
                          processing: t('videos.detail.transcriptStatus.processing'),
                          indexing: t('videos.detail.transcriptStatus.indexing'),
                          error: t('videos.detail.transcriptStatus.error'),
                        };
                        return statusMsgs[video.status] ?? t('videos.detail.transcriptStatus.unavailable');
                      })()}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
