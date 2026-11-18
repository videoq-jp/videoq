import { useQuery } from '@tanstack/react-query';
import type { VideoStatusCounts } from '@videoq/trpc';
import { trpc } from '@/lib/trpc';

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
    refetchInterval: false,
  }));

  return {
    stats: query.data ?? EMPTY_VIDEO_STATUS_COUNTS,
    isLoading: query.isLoading,
    error: query.error,
  };
}
