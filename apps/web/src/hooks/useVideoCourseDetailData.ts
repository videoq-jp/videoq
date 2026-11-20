import { changedCourseMetadata, reorderCourseVideos, addableCourseVideos, rollbackCourseVideoOrder } from '@/application/course-editing';
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Course as VideoCourse } from '@videoq/trpc';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { invalidateAfterCourseRemoval, invalidateAfterCourseUpdate, refreshQuery } from '@/lib/cacheInvalidation';
import { useVideos, type VideosOrdering } from './useVideos';

interface UseVideoCourseDetailQueryResult {
  course: VideoCourse | null;
  isLoading: boolean;
  errorMessage: string | null;
}

export function useVideoCourseDetailQuery(courseId: number | null): UseVideoCourseDetailQueryResult {
  const courseQuery = useQuery(trpc.courses.get.queryOptions({ id: courseId! }, {
    enabled: !!courseId,
    refetchInterval: false,
  }));

  return {
    course: courseQuery.data ?? null,
    isLoading: courseQuery.isLoading,
    errorMessage: courseQuery.error instanceof Error ? courseQuery.error.message : null,
  };
}

interface UseAddableVideosQueryParams {
  isOpen: boolean;
  courseId: number | null;
  course: VideoCourse | null;
  q: string;
  status: string;
  ordering: VideosOrdering;
  tagIds: number[];
}

export function useAddableVideosQuery({
  isOpen,
  courseId,
  course,
  q,
  status,
  ordering,
  tagIds,
}: UseAddableVideosQueryParams) {
  const videosQuery = useVideos({
    enabled: isOpen && !!course && !!courseId,
    q, status, ordering, tagIds,
  });
  const courseVideos = course?.videos;
  const libraryVideos = videosQuery.videos;
  const videos = useMemo(() => addableCourseVideos(courseVideos, libraryVideos), [courseVideos, libraryVideos]);

  return { ...videosQuery, videos };
}

interface UseVideoCourseDetailMutationsParams {
  courseId: number | null;
  onUpdateSuccess?: () => void;
}

export function useAddVideosToCourseMutation(courseId: number | null, onSuccess?: () => void | Promise<void>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (videoIds: number[]) => {
      if (!courseId) {
        throw new Error('Course ID is required');
      }
      return appTrpcClient.memberships.addVideos.mutate({ courseId, videoIds });
    },
    onSuccess: async () => {
      if (courseId) {
        await invalidateAfterCourseUpdate(queryClient, courseId);
      }
      await onSuccess?.();
    },
  });
}

export function useVideoCourseDetailMutations({
  courseId,
  onUpdateSuccess,
}: UseVideoCourseDetailMutationsParams) {
  const queryClient = useQueryClient();

  const removeVideoMutation = useMutation({
    mutationFn: async (videoId: number) => {
      if (!courseId) {
        throw new Error('Course ID is required');
      }
      await appTrpcClient.memberships.removeVideo.mutate({ courseId, videoId });
      await invalidateAfterCourseUpdate(queryClient, courseId);
    },
  });

  const reorderVideosMutation = useMutation({
    mutationFn: async (videoIds: number[]) => {
      if (!courseId) {
        throw new Error('Course ID is required');
      }
      const key = trpc.courses.get.queryKey({ id: courseId });
      const filter = trpc.courses.get.queryFilter({ id: courseId });
      await queryClient.cancelQueries(filter);
      const previous = queryClient.getQueryData(key);
      const optimistic = queryClient.setQueryData(key, (current) => {
        if (!current) return current;
        const videos = reorderCourseVideos(current.videos, videoIds);
        return videos === current.videos ? current : { ...current, videos };
      });
      try {
        await appTrpcClient.memberships.reorderVideos.mutate({ courseId, videoIds });
      } catch (error) {
        // Preserve newer membership data and unrelated metadata during rollback.
        queryClient.setQueryData(key, current => rollbackCourseVideoOrder(current, previous, optimistic));
        await refreshQuery(queryClient, filter);
        throw error;
      }
    },
  });

  const deleteCourseMutation = useMutation({
    mutationFn: async () => {
      if (!courseId) {
        throw new Error('Course ID is required');
      }
      await appTrpcClient.courses.delete.mutate({ id: courseId });
      return courseId;
    },
    onSuccess: (id) => invalidateAfterCourseRemoval(queryClient, id),
  });

  const updateCourseMutation = useMutation({
    mutationFn: async (payload: { name?: string; description?: string }) => {
      if (!courseId) {
        throw new Error('Course ID is required');
      }
      const current = queryClient.getQueryData(trpc.courses.get.queryKey({ id: courseId }));
      const patch = changedCourseMetadata(current, payload);
      if (Object.keys(patch).length === 0) return;
      return appTrpcClient.courses.update.mutate({ id: courseId, ...patch });
    },
    onSuccess: async (course) => {
      if (course) {
        await queryClient.cancelQueries(trpc.courses.get.queryFilter({ id: course.id }));
        queryClient.setQueryData(trpc.courses.get.queryKey({ id: course.id }), course);
      }
      onUpdateSuccess?.();
      if (course) await refreshQuery(queryClient, trpc.courses.list.pathFilter());
    },
  });

  return {
    removeVideoMutation,
    reorderVideosMutation,
    deleteCourseMutation,
    updateCourseMutation,
  };
}
