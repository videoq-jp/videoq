import { useQuery } from '@tanstack/react-query';
import type { VideoStatusCounts } from '@videoq/trpc';
import { trpc } from '@/lib/trpc';
import { IN_PROGRESS_STATUSES } from '@/hooks/useVideos';

export const EMPTY_VIDEO_STATUS_COUNTS: VideoStatusCounts = {
  total: 0,
  completed: 0,
  pending: 0,
  processing: 0,
  indexing: 0,
  error: 0,
  uploading: 0,
};

export function useVideoStatusCounts(enabled = true) {
  const query = useQuery(trpc.videos.statusCounts.queryOptions(undefined, {
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasInProgress = !!data && IN_PROGRESS_STATUSES.some((status) => data[status] > 0);
      return hasInProgress ? 3000 : 30_000;
    },
  }));

  return {
    stats: query.data ?? EMPTY_VIDEO_STATUS_COUNTS,
    isLoading: query.isLoading,
    error: query.error,
  };
}
