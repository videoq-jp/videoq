import { useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { List, Play } from 'lucide-react';
import { CourseSharingNotice } from '@/components/video/course-detail/CourseSharingNotice';
import { Link } from '@/lib/i18n';
import { apiClient, type VideoInCourse } from '@/lib/api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { StatusBadge } from '@/components/common/StatusBadge';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  Breadcrumbs,
  BreadcrumbsLabel,
} from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { ChipLabel } from '@/components/ui/chip-label';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { useVideoPlayback } from '@/hooks/useVideoPlayback';
import { useMobileTab } from '@/hooks/useMobileTab';
import { useSharedCourseQuery } from '@/hooks/useSharePageData';
import { useI18nNavigate } from '@/lib/i18n';
import { buildYoutubeEmbedSrc } from '@/lib/video/embed';

type MobileTab = 'videos' | 'player';

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

  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);

  const { mobileTab, setMobileTab, isMobile } = useMobileTab<MobileTab>('player');
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
    onMobileSwitch: () => setMobileTab('player'),
  });

  const mobileTabIcon: Record<MobileTab, typeof List> = { videos: List, player: Play };
  const mobileTabLabel: Record<MobileTab, string> = {
    videos: t('videos.shared.tabs.videos'),
    player: t('videos.shared.tabs.player'),
  };

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
    <>
      <div className="bg-solid-gray-50 flex flex-col">
      {/* ── Fixed Header ────────────────────────────────────────────────── */}
      <header className="fixed top-0 z-50 w-full border-b border-solid-gray-420 bg-white">
        <div className="mx-auto flex w-full max-w-screen-xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
          <Link href="/" className="shrink-0 text-std-20B-150 text-solid-gray-800">
            VideoQ
          </Link>

          <div className="flex shrink-0 items-center gap-2">
            {headerAction ?? (
              <ChipLabel variant="filled-1" color="blue" className="min-h-0 text-oln-14N-100">
                {t('videos.shared.publicBadge')}
              </ChipLabel>
            )}
          </div>
        </div>
      </header>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <main className="mt-16 flex flex-col px-6 pt-4 gap-4 max-w-[1600px] mx-auto w-full overflow-y-auto pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-4 lg:h-[calc(100dvh-4rem)] lg:overflow-hidden">
        {/* 講座名はバーではなくパンくずで示す（講座詳細と同じ並び）。 */}
        <Breadcrumbs aria-label={t('common.actions.backToHome')} className="shrink-0">
          <BreadcrumbsLabel className="sr-only">
            {t('common.actions.backToHome')}
          </BreadcrumbsLabel>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/">{t('navigation.home')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbItem isCurrent>{course.name}</BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumbs>

        {/* 見出しは非表示にしたが、ページの h1 として構造には残す。 */}
        <h1 className="sr-only">{course.name}</h1>

        {intro}

        <CourseSharingNotice method="link" />

        {/* 3-column grid */}
        <div className="flex flex-col lg:grid lg:grid-cols-4 gap-6 lg:flex-1 lg:min-h-0 lg:items-stretch">

          {/* LEFT: Video list */}
          <aside className={`lg:col-span-1 flex flex-col min-h-0 ${mobileTab === 'videos' ? 'flex' : 'hidden lg:flex'}`}>
            <div className="flex h-full flex-col overflow-hidden rounded-8 border border-solid-gray-300 bg-white">
              <div className="p-4 border-b border-solid-gray-200 flex items-center justify-between shrink-0">
                <h2 className="font-bold text-std-16B-170 text-solid-gray-800">{t('videos.courseDetail.videoListTitle')}</h2>
                <ChipLabel variant="filled-1" color="gray" className="min-h-0 text-oln-14N-100">
                  {t('videos.courseDetail.videoCount', { count: course.videos?.length ?? 0 })}
                </ChipLabel>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {course.videos && course.videos.length > 0 ? (
                  course.videos.map((video) => (
                    <VideoItem
                      key={video.id}
                      video={video}
                      isSelected={selectedVideo?.id === video.id}
                      onSelect={(videoId) => {
                        handleVideoSelect(videoId);
                        if (isMobile) setMobileTab('player');
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
          </aside>

          {/* CENTER: Video player */}
          <section className={`lg:col-span-2 flex flex-col gap-3 lg:min-h-0 ${mobileTab === 'player' ? 'flex' : 'hidden lg:flex'}`}>
            <div className="flex flex-col overflow-hidden border border-solid-gray-420 bg-white lg:flex-1">
              <div className="p-4 border-b border-solid-gray-200 shrink-0 flex items-center justify-between gap-3 min-w-0">
                <h2 className="font-bold text-solid-gray-800 text-std-18B-160 truncate flex-1 min-w-0">
                  {selectedVideo ? selectedVideo.title : t('videos.shared.playerPlaceholder')}
                </h2>
              </div>
              <div className="aspect-video lg:aspect-auto lg:flex-1 bg-solid-gray-800 flex items-center justify-center lg:min-h-0">
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
            </div>
          </section>

          {/* One mounted chat: below the player on mobile, beside it on desktop. */}
          <aside className={`min-h-0 shrink-0 flex-col lg:col-span-1 ${mobileTab === 'player' ? 'flex' : 'hidden lg:flex'}`}>
            <ChatPanel
              courseId={course.id}
              onVideoPlay={(videoId, startTime) => {
                onCitationPlay?.();
                handleVideoPlayFromTime(videoId, startTime);
              }}
              shareToken={shareToken}
              suggestedQuestions={suggestedQuestions}
              sendSuggestedQuestions={!!suggestedQuestions}
              className="h-[480px] lg:h-full lg:min-h-0 lg:flex-1"
            />
          </aside>

        </div>
      </main>

      {/* ── Mobile bottom nav ───────────────────────────────────────────── */}
      <nav className="fixed bottom-0 left-0 z-50 flex min-h-16 w-full items-center justify-around border-t border-solid-gray-420 bg-white px-4 pb-[env(safe-area-inset-bottom)] lg:hidden">
        {(['videos', 'player'] as MobileTab[]).map((tab) => {
          const Icon = mobileTabIcon[tab];
          const isActive = mobileTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              className={`flex flex-col items-center justify-center gap-1 px-4 py-1 transition-colors ${
                isActive ? 'border-b-2 border-key-900 text-key-900' : 'text-solid-gray-600 hover:text-key-900'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-dns-14N-120 font-medium">{mobileTabLabel[tab]}</span>
            </button>
          );
        })}
      </nav>
      </div>
    </>
  );
}

export default function SharePage() {
  const params = useParams<{ token: string }>();
  return <SharedCourseView shareToken={params?.token ?? ''} />;
}
