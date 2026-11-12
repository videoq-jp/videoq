import { features } from "@/lib/deployment";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VideoInCourse, VideoList as VideoListType } from '@/lib/api';
import { apiClient } from '@/lib/api';
import { formatDate, getStatusChipColor, getStatusLabel, getVideoDisplayStatus } from '@/lib/utils/video';
import { Link } from '@/lib/i18n';
import { TagBadge } from './TagBadge';
import { ChipLabel } from '@/components/ui/chip-label';
import { cn } from '@/lib/digital-agency/cn';

interface VideoCardProps {
  video: VideoListType | VideoInCourse;
  showLink?: boolean;
  className?: string;
  onClick?: () => void;
}

/**
 * Custom hook that uses IntersectionObserver to detect when an element
 * enters the viewport. Once visible, stays true (no unloading on scroll-out).
 */
function useInView(rootMargin = '200px') {
  const ref = useRef<HTMLDivElement>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || isInView) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
        }
      },
      { rootMargin },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [isInView, rootMargin]);

  return { ref, isInView };
}

function getYoutubeThumbnailUrl(videoId?: string | null): string | null {
  if (!videoId) return null;
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <svg className="mr-1 h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
      </svg>
    );
  }
  if (status === 'processing' || status === 'indexing' || status === 'uploading') {
    return (
      <svg className="mr-1 h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M6 2v6l2.5 2.5L6 13v6l6-2 6 2v-6l-2.5-2.5L18 8V2l-6 2-6-2z" />
      </svg>
    );
  }
  return (
    <svg className="mr-1 h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
    </svg>
  );
}

function StatusBadgeWithIcon({ status, label }: { status: string; label: string }) {
  return (
    <ChipLabel
      variant="filled-1"
      color={getStatusChipColor(status)}
      className="inline-flex min-h-0 items-center text-oln-14N-100"
    >
      <StatusIcon status={status} />
      {label}
    </ChipLabel>
  );
}

function VideoPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-solid-gray-200">
      <svg className="h-8 w-8 text-solid-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
        />
      </svg>
    </div>
  );
}

function VideoThumbnail({
  video,
  videoRef,
}: {
  video: VideoListType | VideoInCourse;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}) {
  const { ref: thumbRef, isInView } = useInView('200px');

  const youtubeThumb =
    features.youtube && video.source_type === 'youtube' ? getYoutubeThumbnailUrl(video.youtube_video_id) : null;

  return (
    <div ref={thumbRef} className="relative h-full w-full overflow-hidden bg-solid-gray-100">
      {youtubeThumb ? (
        <img
          className="absolute inset-0 h-full w-full object-cover"
          src={youtubeThumb}
          alt={video.title}
          loading="lazy"
        />
      ) : video.file ? (
        isInView ? (
          <video
            ref={videoRef}
            className="absolute inset-0 h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
            src={apiClient.getVideoUrl(video.file)}
          />
        ) : (
          <VideoPlaceholder />
        )
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg
            className="h-8 w-8 text-solid-gray-420"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        </div>
      )}
    </div>
  );
}

export function VideoCard({ video, showLink = true, className = '', onClick }: VideoCardProps) {
  const { t, i18n } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleMouseEnter = useCallback(() => {
    void videoRef.current?.play().catch(() => {});
  }, []);

  const handleMouseLeave = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.pause();
    vid.currentTime = 0;
  }, []);

  const rowContent = (
    <div
      className={cn(
        'group grid w-full cursor-pointer grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-2 px-2 py-6 sm:flex sm:items-center md:px-4',
        className,
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="row-span-2 aspect-video w-28 shrink-0 overflow-hidden border border-solid-gray-420 bg-solid-gray-100 sm:w-36">
        <VideoThumbnail video={video} videoRef={videoRef} />
      </div>

      <div className="min-w-0 flex-1">
        <p className="break-words text-std-17B-170 text-solid-gray-800 group-hover:underline">
          {video.title}
        </p>
        <p className="mt-1 text-dns-14N-130 text-solid-gray-600">
          {formatDate(video.uploaded_at, 'full', i18n.language)}
        </p>
        {'tags' in video && video.tags && video.tags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {video.tags.map((tag) => (
              <TagBadge key={tag.id} tag={tag} size="sm" />
            ))}
          </div>
        ) : null}
      </div>

      <div className="col-start-2 shrink-0">
        <StatusBadgeWithIcon status={getVideoDisplayStatus(video)} label={t(getStatusLabel(getVideoDisplayStatus(video)))} />
      </div>
    </div>
  );

  if (showLink && 'id' in video) {
    return (
      <Link href={`/videos/${video.id}`} className="block no-underline">
        {rowContent}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {rowContent}
      </div>
    );
  }

  return rowContent;
}
