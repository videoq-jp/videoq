import { features } from "@/lib/deployment";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlignLeft,
  ArrowLeft,
  Calendar,
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
import { ViewerHeader } from '@/components/video/ViewerHeader';
import { ViewerActionsMenu } from '@/components/video/ViewerActionsMenu';
import { MenuList, MenuListItem, MenuListItemButton } from '@/components/ui/menu-list';
import { useViewerViewport } from '@/hooks/useViewerViewport';
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
        aria-pressed={activeTab === 'video'}
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
        aria-pressed={activeTab === 'transcript'}
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
    <div className="w-full aspect-video overflow-hidden bg-black">
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
}: {
  video: Video;
  deleteError: string | null;
}) {
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-4 px-4 py-5 lg:px-8 lg:py-6">
      <div className="flex flex-wrap items-center gap-3 text-dns-14N-130 text-solid-gray-600">
        <Calendar className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{formatDate(video.uploaded_at, 'full', locale)}</span>
        <StatusBadge status={getVideoDisplayStatus(video)} size="sm" className="ml-0" />
      </div>

      {video.tags && video.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {video.tags.map((tag) => (
            <TagBadge key={tag.id} tag={tag} size="sm" />
          ))}
        </div>
      )}

      {video.error_message && <ErrorMessage message={video.error_message} />}

      {video.description && (
        <div className="border-t border-solid-gray-200 pt-4">
          <p className="text-std-17N-170 text-solid-gray-700 leading-relaxed">{video.description}</p>
        </div>
      )}

      {deleteError && <ErrorMessage message={deleteError} />}
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
  const viewportHeight = useViewerViewport();

  return (
    <>
      {isLoading ? (
        <LoadingSpinner fullScreen />
      ) : error && !video ? (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
          <ErrorMessage message={error} />
          <UtilityLink asChild>
            <Link href="/videos" className="inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" />
              {t('common.actions.backToList')}
            </Link>
          </UtilityLink>
        </div>
      ) : !video ? (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
          <p className="text-solid-gray-700">{t('common.messages.videoNotFound')}</p>
          <UtilityLink asChild>
            <Link href="/videos">{t('common.actions.backToList')}</Link>
          </UtilityLink>
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

          <div data-video-viewer style={{ height: viewportHeight }} className="flex h-dvh flex-col overflow-hidden bg-white">
            <ViewerHeader title={video.title} backHref="/videos">
              <ViewerActionsMenu label={t('videos.detail.manage')}>
                <MenuList>
                  <MenuListItem>
                    <MenuListItemButton type="box" size="regular" onClick={onStartEditing}>
                      <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>{t('videos.detail.editButton')}</span>
                    </MenuListItemButton>
                  </MenuListItem>
                  <MenuListItem className="mt-1 border-t border-solid-gray-200 pt-1">
                    <MenuListItemButton type="box" size="regular" onClick={onDeleteVideo} disabled={isDeleting} className="text-error-1 hover:bg-red-50">
                      {isDeleting ? <InlineSpinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                      <span>{isDeleting ? t('common.actions.deleting') : t('videos.detail.deleteButton')}</span>
                    </MenuListItemButton>
                  </MenuListItem>
                </MenuList>
              </ViewerActionsMenu>
            </ViewerHeader>
            {isMobile && <VideoDetailMobileTabs activeTab={mobileTab} onChange={onMobileTabChange} />}
            <main className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(22rem,3fr)]">
              <div className={`min-w-0 min-h-0 overflow-y-auto ${isMobile && mobileTab !== 'video' ? 'hidden' : ''}`}>
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
            </main>
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
