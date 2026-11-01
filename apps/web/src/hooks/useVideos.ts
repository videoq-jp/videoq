import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Video, VideoListItem as VideoListType, VideoStatus } from '@videoq/trpc';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/lib/trpc';
import { useInfiniteScroll } from './useInfiniteScroll';

const PAGE_SIZE = 24;

export const IN_PROGRESS_STATUSES: VideoStatus[] = ['pending', 'processing', 'indexing', 'uploading'];

function isInProgressStatus(status: VideoStatus | undefined): boolean {
  return !!status && IN_PROGRESS_STATUSES.includes(status);
}

export type VideosOrdering = 'uploaded_at_desc' | 'uploaded_at_asc' | 'title_asc' | 'title_desc';

interface UseVideosParams {
  enabled?: boolean;
  tagIds?: number[];
  q?: string;
  status?: string;
  ordering?: VideosOrdering;
}

/**
 * Hook to fetch video list with infinite scroll pagination
 */
interface UseVideosReturn {
  videos: VideoListType[];
  isLoading: boolean;
  error: string | null;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  isFetchNextPageError: boolean;
  refetch: () => Promise<unknown>;
  totalCount: number;
  sentinelRef: React.RefCallback<HTMLElement>;
}

export function useVideos(params?: UseVideosParams): UseVideosReturn {
  const normalizedTagIds = params?.tagIds?.length ? params.tagIds : undefined;
  const q = params?.q?.trim() || undefined;
  const status = params?.status?.trim() || undefined;
  const ordering: VideosOrdering | undefined = params?.ordering || undefined;

  const videosQuery = useInfiniteQuery(trpc.videos.list.infiniteQueryOptions({
    tags: normalizedTagIds,
    q,
    status,
    ordering,
    limit: PAGE_SIZE,
  }, {
    enabled: params?.enabled,
    initialCursor: 0,
    getNextPageParam: (lastPage) => {
      if (lastPage.data.length === 0) return undefined;
      const nextOffset = lastPage.meta.offset + lastPage.data.length;
      return nextOffset < lastPage.meta.total ? nextOffset : undefined;
    },
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const hasInProgress = pages.some((page) =>
        page.data.some((video) => isInProgressStatus(video.status) || video.visual_processing?.status === 'processing'),
      );
      if (hasInProgress) return 3000;
      return pages.some(page => page.data.some(video => video.visual_processing?.status === 'error')) ? 30_000 : false;
    },
  }));

  const videos = useMemo(
    () => videosQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [videosQuery.data],
  );

  const totalCount = videosQuery.data?.pages[0]?.meta.total ?? 0;

  const sentinelRef = useInfiniteScroll(videosQuery);

  return {
    videos,
    isLoading: videosQuery.isLoading,
    error: videosQuery.error instanceof Error ? videosQuery.error.message : null,
    hasNextPage: videosQuery.hasNextPage,
    fetchNextPage: () => videosQuery.fetchNextPage({ cancelRefetch: false }),
    isFetchingNextPage: videosQuery.isFetchingNextPage,
    isFetching: videosQuery.isFetching,
    isFetchNextPageError: videosQuery.isFetchNextPageError,
    refetch: videosQuery.refetch,
    totalCount,
    sentinelRef,
  };
}

/**
 * Hook to fetch a single video
 */
interface UseVideoReturn {
  video: Video | null;
  isLoading: boolean;
  error: string | null;
}

export function useVideo(videoId: number | null): UseVideoReturn {
  const { user, isLoading: authLoading } = useAuth();

  const videoQuery = useQuery(trpc.videos.get.queryOptions({ id: videoId! }, {
    enabled: !!videoId && !!user,
    refetchInterval: (query) => {
      const video = query.state.data;
      if (isInProgressStatus(video?.status) || video?.visual_processing?.status === 'processing') return 3000;
      return video?.visual_processing?.status === 'error' ? 30_000 : false;
    },
  }));

  return {
    video: videoQuery.data || null,
    isLoading: (!!videoId && authLoading) || videoQuery.isLoading,
    error: videoQuery.error instanceof Error ? videoQuery.error.message : null,
  };
}
