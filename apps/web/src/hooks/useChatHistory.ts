import { useEffect } from 'react';
import { canReadCourseHistory } from '@/application/course-access';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { trpc } from '@/lib/trpc';

interface UseChatHistoryParams {
  courseId?: number;
  shareToken?: string;
  enabled: boolean;
}

export function useChatHistory({ courseId, shareToken, enabled }: UseChatHistoryParams) {
  // History is ordered by chat creation time and ID, newest first.
  const pageInput = { courseId: courseId!, limit: 100, offset: 0 };
  const canLoadHistory = enabled && canReadCourseHistory(courseId, shareToken);

  const historyQuery = useQuery(trpc.chat.history.queryOptions(pageInput, {
    enabled: canLoadHistory,
  }));

  useEffect(() => {
    if (enabled && historyQuery.error) {
      console.error('Failed to load history', historyQuery.error);
    }
  }, [enabled, historyQuery.error]);

  const exportHistoryCsvMutation = useMutation({
    mutationFn: async () => {
      if (!canReadCourseHistory(courseId, shareToken)) {
        return;
      }
      await apiClient.exportChatHistoryCsv(courseId!);
    },
    onError: (e) => {
      console.error('Failed to export CSV', e);
    },
  });

  return {
    history: historyQuery.data?.data ?? null,
    historyLoading: historyQuery.isLoading,
    historyError: historyQuery.error,
    exportHistoryCsv: exportHistoryCsvMutation.mutate,
    isExportingHistoryCsv: exportHistoryCsvMutation.isPending,
  };
}
