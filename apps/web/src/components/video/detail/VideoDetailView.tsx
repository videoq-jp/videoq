import { features } from "@/lib/deployment";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlignLeft,
  ArrowLeft,
  Calendar,
  CheckCircle,
  Pencil,
  Play,
  Trash2,
  Video as VideoIcon,
} from 'lucide-react';
import { Link, useLocale } from '@/lib/i18n';
import { apiClient, type Tag, type Video } from '@/lib/api';
import { buildYoutubeEmbedSrc } from '@/lib/video/embed';
import { formatDate, getVideoDisplayStatus } from '@/lib/utils/video';
import type { TranscriptSegment } from '@/lib/transcript/srt';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { StatusBadge } from '@/components/common/StatusBadge';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { TagCreateDialog } from '@/components/video/TagCreateDialog';
import { TagBadge } from '@/components/video/TagBadge';
import { Button } from '@/components/ui/button';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  Breadcrumbs,
  BreadcrumbsLabel,
} from '@/components/ui/breadcrumbs';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { UtilityLink } from '@/components/ui/utility-link';
import { TranscriptPanel } from './TranscriptPanel';
import { VideoDetailEditDialog } from './VideoDetailEditDialog';

type MobileTab = 'transcript' | 'video';

interface VideoDetailViewProps {
  video: Video | null;
  isLoading: boolean;
  error: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  youtubeStartSeconds: number | null;
  youtubeSeekId: number;
  onVideoLoaded: () => void;
  isMobile: boolean;
  mobileTab: MobileTab;
  onMobileTabChange: (tab: MobileTab) => void;
  tags: Tag[];
  isCreateDialogOpen: boolean;
  onCreateDialogOpenChange: (open: boolean) => void;
  onCreateTag: (name: string, color: string) => Promise<void>;
  isEditing: boolean;
  editedTitle: string;
  editedDescription: string;
  editedTagIds: number[];
  onEditedTitleChange: (title: string) => void;
  onEditedDescriptionChange: (description: string) => void;
  onEditedTagIdsChange: Dispatch<SetStateAction<number[]>>;
  onStartEditing: () => void;
  onCancelEdit: () => void;
  onUpdateVideo: () => void;
  isUpdating: boolean;
  updateError: string | null;
  deleteError: string | null;
  isDeleting: boolean;
  onDeleteVideo: () => void;
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
}

function VideoDetailMobileTabs({
  activeTab,
  onChange,
}: {
  activeTab: MobileTab;
  onChange: (tab: MobileTab) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 border-b border-solid-gray-200 bg-white">
      <button
        type="button"
        onClick={() => onChange('video')}
        className={`flex-1 flex items-center justify-center gap-2 py-3 text-oln-16B-100 transition-colors ${
          activeTab === 'video'
            ? 'text-key-900 border-b-2 border-key-900'
            : 'text-solid-gray-536 hover:text-solid-gray-800'
        }`}
      >
        <Play className="w-4 h-4" />
        {t('videos.detail.video')}
      </button>
      <button
        type="button"
        onClick={() => onChange('transcript')}
        className={`flex-1 flex items-center justify-center gap-2 py-3 text-oln-16B-100 transition-colors ${
          activeTab === 'transcript'
            ? 'text-key-900 border-b-2 border-key-900'
            : 'text-solid-gray-536 hover:text-solid-gray-800'
        }`}
      >
        <AlignLeft className="w-4 h-4" />
        {t('videos.detail.transcriptSection')}
      </button>
    </div>
  );
}

function VideoPlayerPanel({
  video,
  videoRef,
  youtubeStartSeconds,
  youtubeSeekId,
  onVideoLoaded,
}: {
  video: Video;
  videoRef: RefObject<HTMLVideoElement | null>;
  youtubeStartSeconds: number | null;
  youtubeSeekId: number;
  onVideoLoaded: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="w-full aspect-video overflow-hidden border border-solid-gray-420 bg-solid-gray-800">
      {features.youtube && video.source_type === 'youtube' && video.youtube_embed_url ? (
        <iframe
          key={`${video.id}-${youtubeStartSeconds ?? 0}-${youtubeSeekId}`}
          className="w-full h-full"
          src={buildYoutubeEmbedSrc(video.youtube_embed_url, youtubeStartSeconds)}
          title={video.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : video.file ? (
        <video
          ref={videoRef}
          controls
          className="w-full h-full object-contain"
          src={apiClient.getVideoUrl(video.file)}
          onLoadedMetadata={onVideoLoaded}
        >
          {t('common.messages.browserNoVideoSupport')}
        </video>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-solid-gray-200">
          <VideoIcon className="w-16 h-16 text-solid-gray-300" />
          <p className="text-std-17N-170">{t('common.messages.videoFileMissing')}</p>
        </div>
      )}
    </div>
  );
}

function VideoMetaPanel({
  video,
  deleteError,
  isDeleting,
  onEdit,
  onDelete,
}: {
  video: Video;
  deleteError: string | null;
  isDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const pipelineSteps = [
    { key: 'upload', label: t('videos.detail.pipeline.upload'), doneStatuses: ['processing', 'indexing', 'completed', 'error'] },
    { key: 'transcript', label: t('videos.detail.pipeline.transcript'), doneStatuses: ['indexing', 'completed'] },
    { key: 'aiAnalysis', label: t('videos.detail.pipeline.aiAnalysis'), doneStatuses: ['completed'] },
  ] as { key: string; label: string; doneStatuses: Video['status'][] }[];

  return (
    <div className="flex flex-col gap-4 border border-solid-gray-420 bg-white p-6">
      <div className="flex justify-between items-start gap-4">
        <div>
          <Heading size="32" className="mb-3 text-std-24B-150 md:text-std-32B-150">
            <HeadingTitle level="h1">{video.title}</HeadingTitle>
          </Heading>
          <div className="flex items-center gap-2 text-std-17N-170 text-solid-gray-600">
            <Calendar className="w-3.5 h-3.5 shrink-0" />
            <span>{formatDate(video.uploaded_at, 'full', locale)}</span>
          </div>
        </div>
        <StatusBadge status={getVideoDisplayStatus(video)} size="sm" className="ml-0 shrink-0" />
      </div>

      {video.tags && video.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {video.tags.map((tag) => (
            <TagBadge key={tag.id} tag={tag} size="sm" />
          ))}
        </div>
      )}

      <div className="border-t border-solid-gray-200 pt-4 flex items-center gap-3 flex-wrap">
        <span className="text-dns-14B-120 text-solid-gray-600 uppercase tracking-widest shrink-0">
          {t('videos.detail.statusSection')}
        </span>
        {pipelineSteps.map(({ key, label, doneStatuses }, index) => {
          const done = doneStatuses.includes(video.status);
          return (
            <div key={key} className="flex items-center gap-2">
              {index > 0 && <div className="w-6 h-px bg-solid-gray-300" />}
              <div className="flex items-center gap-1.5">
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                    done ? 'bg-key-900' : 'bg-solid-gray-300'
                  }`}
                >
                  {done ? (
                    <CheckCircle className="w-3 h-3 text-white" />
                  ) : (
                    <div className="w-1.5 h-1.5 rounded-full bg-solid-gray-420" />
                  )}
                </div>
                <span className={`text-dns-14B-120 ${done ? 'text-solid-gray-800' : 'text-solid-gray-600'}`}>
                  {label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {video.error_message && <ErrorMessage message={video.error_message} />}
      {video.visual_processing && (
        <div role="status" className="border-t border-solid-gray-200 pt-4 text-std-17N-170">
          <p>{t(`videos.detail.visual.${video.visual_processing.status}`)}</p>
          {video.visual_processing.status !== 'ready' && (
            <p>{t('videos.detail.visual.progress', { completed: video.visual_processing.completed_chunks, total: video.visual_processing.total_chunks })}</p>
          )}
        </div>
      )}

      {video.description && (
        <div className="border-t border-solid-gray-200 pt-4">
          <p className="text-std-17N-170 text-solid-gray-700 leading-relaxed">{video.description}</p>
        </div>
      )}

      {deleteError && <ErrorMessage message={deleteError} />}

      <div className="border-t border-solid-gray-200 pt-4 flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="w-3.5 h-3.5 mr-1.5" />
          {t('videos.detail.editButton')}
        </Button>
        <Button
          type="button"
          variant="text"
          size="sm"
          onClick={onDelete}
          disabled={isDeleting}
          className="text-error-1 hover:bg-red-50"
        >
          {isDeleting ? <InlineSpinner className="w-3.5 h-3.5 mr-1.5" /> : <Trash2 className="w-3.5 h-3.5 mr-1.5" />}
          {isDeleting ? t('common.actions.deleting') : t('videos.detail.deleteButton')}
        </Button>
      </div>
    </div>
  );
}

export function VideoDetailView({
  video,
  isLoading,
  error,
  videoRef,
  youtubeStartSeconds,
  youtubeSeekId,
  onVideoLoaded,
  isMobile,
  mobileTab,
  onMobileTabChange,
  tags,
  isCreateDialogOpen,
  onCreateDialogOpenChange,
  onCreateTag,
  isEditing,
  editedTitle,
  editedDescription,
  editedTagIds,
  onEditedTitleChange,
  onEditedDescriptionChange,
  onEditedTagIdsChange,
  onStartEditing,
  onCancelEdit,
  onUpdateVideo,
  isUpdating,
  updateError,
  deleteError,
  isDeleting,
  onDeleteVideo,
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
}: VideoDetailViewProps) {
  const { t } = useTranslation();

  return (
    <>
      {isLoading ? (
        <LoadingSpinner fullScreen />
      ) : error && !video ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <ErrorMessage message={error} />
          <UtilityLink asChild>
            <Link href="/videos" className="inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" />
              {t('common.actions.backToList')}
            </Link>
          </UtilityLink>
        </div>
      ) : !video ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-solid-gray-700">{t('common.messages.videoNotFound')}</p>
        </div>
      ) : (
        <>
          <VideoDetailEditDialog
            isOpen={isEditing}
            tags={tags}
            editedTitle={editedTitle}
            editedDescription={editedDescription}
            editedTagIds={editedTagIds}
            isUpdating={isUpdating}
            updateError={updateError}
            onOpenChange={(open) => !open && onCancelEdit()}
            onEditedTitleChange={onEditedTitleChange}
            onEditedDescriptionChange={onEditedDescriptionChange}
            onEditedTagIdsChange={onEditedTagIdsChange}
            onCreateNewTag={() => onCreateDialogOpenChange(true)}
            onSave={onUpdateVideo}
          />

          {isMobile && (
            <VideoDetailMobileTabs activeTab={mobileTab} onChange={onMobileTabChange} />
          )}

          <div className="mx-auto flex w-full max-w-[77.375rem] flex-grow flex-col gap-8 px-6 py-12 md:py-20">
            <Breadcrumbs aria-label={t('common.actions.backToList')}>
              <BreadcrumbsLabel className="sr-only">
                {t('common.actions.backToList')}
              </BreadcrumbsLabel>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href="/videos">{t('navigation.videoLibrary')}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbItem isCurrent>{video.title}</BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumbs>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div
                className={`lg:col-span-8 flex flex-col gap-4 ${
                  isMobile && mobileTab !== 'video' ? 'hidden' : ''
                }`}
              >
                <VideoPlayerPanel
                  video={video}
                  videoRef={videoRef}
                  youtubeStartSeconds={youtubeStartSeconds}
                  youtubeSeekId={youtubeSeekId}
                  onVideoLoaded={onVideoLoaded}
                />
                <VideoMetaPanel
                  video={video}
                  deleteError={deleteError}
                  isDeleting={isDeleting}
                  onEdit={onStartEditing}
                  onDelete={onDeleteVideo}
                />
              </div>

              <TranscriptPanel
                video={video}
                isMobile={isMobile}
                mobileTab={mobileTab}
                transcriptSearch={transcriptSearch}
                onTranscriptSearchChange={onTranscriptSearchChange}
                isTranscriptEditing={isTranscriptEditing}
                onStartTranscriptEditing={onStartTranscriptEditing}
                onCancelTranscriptEditing={onCancelTranscriptEditing}
                editedTranscript={editedTranscript}
                onEditedTranscriptChange={onEditedTranscriptChange}
                onSaveTranscript={onSaveTranscript}
                isTranscriptSaving={isTranscriptSaving}
                transcriptSaveError={transcriptSaveError}
                filteredSegments={filteredSegments}
                activeSegmentIdx={activeSegmentIdx}
                onSeek={onSeek}
                isPlainTextTranscript={isPlainTextTranscript}
              />
            </div>

          </div>

          <TagCreateDialog
            isOpen={isCreateDialogOpen}
            onClose={() => onCreateDialogOpenChange(false)}
            onCreate={onCreateTag}
          />
        </>
      )}
    </>
  );
}
