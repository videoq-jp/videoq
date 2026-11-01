import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, type RefCallback } from 'react';
import type { CourseListItem } from '@videoq/trpc';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/lib/trpc';
import { useInfiniteScroll } from './useInfiniteScroll';

const PAGE_SIZE = 24;

interface UseVideoCoursesReturn {
  courses: CourseListItem[];
  isLoading: boolean;
  error: string | null;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  retry: () => Promise<unknown>;
  sentinelRef: RefCallback<HTMLElement>;
}

/**
 * Fetch the list of video courses with infinite scroll pagination.
 */
export function useVideoCourses(): UseVideoCoursesReturn {
  const { user, isLoading: authLoading } = useAuth();

  const coursesQuery = useInfiniteQuery(trpc.courses.list.infiniteQueryOptions(
    { limit: PAGE_SIZE },
    {
      enabled: !!user,
      initialCursor: 0,
      getNextPageParam: (lastPage) => {
        if (lastPage.data.length === 0) return undefined;
        const nextOffset = lastPage.meta.offset + lastPage.data.length;
        return nextOffset < lastPage.meta.total ? nextOffset : undefined;
      },
    },
  ));

  const courses = useMemo(
    () => coursesQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [coursesQuery.data],
  );

  useEffect(() => {
    if (coursesQuery.error) {
      console.error('Failed to load video courses', coursesQuery.error);
    }
  }, [coursesQuery.error]);

  const sentinelRef = useInfiniteScroll(coursesQuery);

  return {
    courses,
    isLoading: authLoading || coursesQuery.isLoading,
    error: coursesQuery.error instanceof Error ? coursesQuery.error.message : null,
    isFetchingNextPage: coursesQuery.isFetchingNextPage,
    isFetching: coursesQuery.isFetching,
    retry: () => coursesQuery.isFetchNextPageError
      ? coursesQuery.fetchNextPage({ cancelRefetch: false })
      : coursesQuery.refetch({ cancelRefetch: false }),
    sentinelRef,
  };
}
