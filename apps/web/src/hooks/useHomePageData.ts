import { useQuery } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

interface UseHomePageDataParams {
  userId: string | null | undefined;
}

export function useHomePageData({ userId }: UseHomePageDataParams) {
  const videosQuery = useQuery(trpc.videos.list.queryOptions({
    limit: 5,
    ordering: 'uploaded_at_desc',
  }, {
    enabled: !!userId,
    trpc: { context: { independentLoading: true } },
  }));
  const coursesQuery = useQuery(trpc.courses.list.queryOptions({ limit: 1 }, {
    enabled: !!userId,
    trpc: { context: { independentLoading: true } },
  }));
  // The list puts the user's own courses before joined ones, so the first
  // item is owned exactly when the user owns at least one course.
  const firstCourse = coursesQuery.data?.data[0];
  const ownedCourse = firstCourse?.access_role === 'owner' ? firstCourse : null;
  // Whether anyone has asked in that course yet. The AI answer counter is not
  // usable here: it is charged to the owner and resets every month.
  const historyQuery = useQuery(trpc.chat.history.queryOptions({
    courseId: ownedCourse?.id ?? 0,
    limit: 1,
    offset: 0,
  }, {
    enabled: !!ownedCourse,
  }));

  return {
    videos: videosQuery.data?.data ?? [],
    courseCount: coursesQuery.data?.meta.total ?? 0,
    ownedCourse,
    hasCourseQuestions: (historyQuery.data?.meta.total ?? 0) > 0,
    // Kept apart from isLoading so the rest of the page does not wait on it.
    isCourseQuestionsLoading: historyQuery.isLoading,
    isVideosLoading: videosQuery.isLoading,
    isCoursesLoading: coursesQuery.isLoading,
    isLoading: videosQuery.isLoading || coursesQuery.isLoading,
  };
}
