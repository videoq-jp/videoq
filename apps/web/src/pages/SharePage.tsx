import { CourseLearningDetails } from '@/components/video/CourseLearningDetails';
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiClient, type VideoInCourse } from '@/lib/api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { StatusBadge } from '@/components/common/StatusBadge';
import { Button } from '@/components/ui/button';
import { ChipLabel } from '@/components/ui/chip-label';
import { ViewerHeader } from '@/components/video/ViewerHeader';
import { PanelTabs, type PanelTab } from '@/components/video/ViewerPanels';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { useVideoPlayback } from '@/hooks/useVideoPlayback';
import { useMobileTab } from '@/hooks/useMobileTab';
import { useSharedCourseQuery } from '@/hooks/useSharePageData';
import { useI18nNavigate } from '@/lib/i18n';
import { buildYoutubeEmbedSrc } from '@/lib/video/embed';

// ── Video list item ───────────────────────────────────────────────────────────

interface VideoItemProps {
  video: VideoInCourse;
  isSelected: boolean;
  onSelect: (videoId: number) => void;
}

function VideoItem({ video, isSelected, onSelect }: VideoItemProps) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={() => onSelect(video.id)}
      className={`flex w-full items-center gap-2 p-3 text-left rounded-8 transition-colors focus-visible:outline-4 focus-visible:outline-black ${
        isSelected ? 'border-l-4 border-key-900 bg-key-50' : 'hover:bg-solid-gray-50'
      }`}
    >
      <span className="flex-1 min-w-0">
        <span className={`block text-std-16N-170 truncate leading-tight ${isSelected ? 'font-bold text-key-900' : 'font-medium text-solid-gray-800'}`}>
          {video.title}
        </span>
        <StatusBadge status={video.status} size="xs" className="mt-1 ml-0" />
      </span>
    </button>
  );
}

// ── Side panel tabs ───────────────────────────────────────────────────────────

// ── Main page ─────────────────────────────────────────────────────────────────

interface SharedCourseViewProps {
  shareToken: string;
  headerAction?: ReactNode;
  intro?: ReactNode;
  suggestedQuestions?: string[];
  onCitationPlay?: () => void;
  loadingContent?: ReactNode;
}

export function SharedCourseView({ shareToken, headerAction, intro, suggestedQuestions, onCitationPlay, loadingContent }: SharedCourseViewProps) {
  const { t } = useTranslation();
  const navigate = useI18nNavigate();
  const panelIdPrefix = useId();
  const pageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);

  const { mobileTab: requestedTab, setMobileTab: setPanelTab } = useMobileTab<PanelTab>('assistant');
  const courseQuery = useSharedCourseQuery(shareToken);
  const course = courseQuery.data ?? null;
  const error = courseQuery.error ? t('common.messages.shareLoadFailed') : null;
  const isLoading = courseQuery.isLoading;

  const selectedVideo = useMemo(() => {
    if (!course?.videos?.length) return null;
    const selected = selectedVideoId
      ? course.videos.find((video) => video.id === selectedVideoId)
      : null;
    return selected ?? course.videos[0];
  }, [course, selectedVideoId]);

  const { videoRef, handleVideoSelect, handleVideoCanPlay, handleVideoPlayFromTime, youtubeStartSeconds, youtubeSeekId } = useVideoPlayback({
    selectedVideo,
    onVideoSelect: setSelectedVideoId,
  });

  const panelTabs: PanelTab[] = ['videos', 'assistant'];
  const activeTab = panelTabs.includes(requestedTab) ? requestedTab : 'assistant';

  const revealPlayer = () => {
    if (pageRef.current) pageRef.current.scrollTop = 0;
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  const panelProps = (tab: PanelTab) => ({
    id: `${panelIdPrefix}-panel-${tab}`,
    role: 'tabpanel',
    'aria-labelledby': `${panelIdPrefix}-tab-${tab}`,
    // Hide without unmounting or display:none: a streaming answer and its scroll
    // position must survive switching tabs.
    className: `absolute inset-0 flex flex-col ${activeTab === tab ? '' : 'invisible'}`,
  });

  // ── Loading ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return loadingContent ?? (
      <div className="min-h-dvh bg-solid-gray-50">
        <LoadingSpinner fullScreen />
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  if (error || !course) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-solid-gray-50 gap-4">
        <p className="text-error-1">{error || t('common.messages.shareNotFound')}</p>
        <Button variant="solid" size="md" onClick={() => navigate('/')}>
          {t('common.actions.backToHome')}
        </Button>
      </div>
    );
  }

  // ── Main ───────────────────────────────────────────────────────────────────

  return (
    <div ref={pageRef} className="flex h-dvh flex-col overflow-y-auto bg-white lg:overflow-hidden">
      <ViewerHeader title={course.name}>
          {headerAction ?? (
            <ChipLabel variant="filled-1" color="blue" className="min-h-0 text-oln-14N-100">
              {t('videos.shared.publicBadge')}
            </ChipLabel>
          )}
      </ViewerHeader>

      {intro ? <div className="shrink-0 border-b border-solid-gray-420 px-4 py-2 lg:px-6">{intro}</div> : null}

      <main className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,7fr)_minmax(22rem,3fr)]">
        {/* LEFT: player, then details that scroll under it */}
        <section ref={contentRef} className="shrink-0 lg:min-h-0 lg:overflow-y-auto">
          <div className="flex aspect-video max-h-[45dvh] w-full items-center justify-center bg-black lg:max-h-[72dvh]">
            {selectedVideo ? (
              selectedVideo.source_type === 'youtube' && selectedVideo.youtube_embed_url ? (
                <iframe
                  key={`${selectedVideo.id}-${youtubeSeekId}`}
                  className="w-full h-full"
                  src={buildYoutubeEmbedSrc(selectedVideo.youtube_embed_url, youtubeStartSeconds)}
                  title={selectedVideo.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : selectedVideo.file ? (
                <video
                  ref={videoRef}
                  key={selectedVideo.id}
                  controls
                  className="w-full h-full object-contain"
                  src={apiClient.getSharedVideoUrl(selectedVideo.file, shareToken)}
                  onCanPlay={handleVideoCanPlay}
                >
                  {t('common.messages.browserNoVideoSupport')}
                </video>
              ) : (
                <p className="text-solid-gray-200 text-std-16N-170">{t('videos.shared.videoNoFile')}</p>
              )
            ) : (
              <p className="text-solid-gray-200 text-std-16N-170 text-center px-4">{t('videos.shared.playerPlaceholder')}</p>
            )}
          </div>
          <div className="space-y-4 px-4 py-3 lg:mx-auto lg:max-w-4xl lg:px-8 lg:py-6">
            <h2 className="truncate text-std-16B-170 text-solid-gray-800 lg:whitespace-normal lg:text-std-20B-150">
              {selectedVideo ? selectedVideo.title : t('videos.shared.playerPlaceholder')}
            </h2>
          </div>
          <CourseLearningDetails key={JSON.stringify([course.id, shareToken])} courseId={course.id} shareSlug={shareToken}
            videoId={selectedVideo?.id} videoTitle={selectedVideo?.title} videoDescription={selectedVideo?.description} courseDescription={course.description}
            onVideoPlay={(id, time) => { onCitationPlay?.(); handleVideoPlayFromTime(id, time); revealPlayer(); }} />
        </section>

        {/* RIGHT: one mounted chat beside the player on desktop, below it on mobile. */}
        <aside className="flex min-h-[28rem] flex-1 flex-col border-t border-solid-gray-420 pb-[env(safe-area-inset-bottom)] lg:min-h-0 lg:border-l lg:border-t-0">
          <PanelTabs tabs={panelTabs} activeTab={activeTab} idPrefix={panelIdPrefix} onChange={setPanelTab} />
          <div className="relative min-h-0 flex-1">
            <div {...panelProps('videos')}>
              <p className="shrink-0 px-4 pt-3 text-dns-14N-130 text-solid-gray-600">
                {t('videos.courseDetail.videoCount', { count: course.videos?.length ?? 0 })}
              </p>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {course.videos && course.videos.length > 0 ? (
                  course.videos.map((video) => (
                    <VideoItem
                      key={video.id}
                      video={video}
                      isSelected={selectedVideo?.id === video.id}
                      onSelect={(videoId) => {
                        handleVideoSelect(videoId);
                        revealPlayer();
                      }}
                    />
                  ))
                ) : (
                  <p className="text-center text-solid-gray-600 py-8 text-std-16N-170">
                    {t('videos.shared.noVideos')}
                  </p>
                )}
              </div>
            </div>
            <div {...panelProps('assistant')}>
              <ChatPanel
                courseId={course.id}
                onVideoPlay={(videoId, startTime) => {
                  onCitationPlay?.();
                  handleVideoPlayFromTime(videoId, startTime);
                  revealPlayer();
                }}
                shareToken={shareToken}
                suggestedQuestions={suggestedQuestions}
                sendSuggestedQuestions={!!suggestedQuestions}
                showTitle={false}
                className="min-h-0 flex-1 border-0"
              />
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default function SharePage() {
  const params = useParams<{ token: string }>();
  return <SharedCourseView shareToken={params?.token ?? ''} />;
}
