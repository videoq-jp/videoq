import type { ChatRepository, ChatHistoryExportRow } from '../../persistence/contracts/chat-repository';
import { textValueFailure } from '@videoq/domain/text-value';
import { validationFailure } from '../../application/errors';

export interface ChatHistoryDependencies {
  chat: Pick<ChatRepository, 'shareExists' | 'history' | 'deleteHistory' | 'analytics' | 'feedback'>;
  courseOwnedBy(courseId: number, userId: string): Promise<boolean>;
  historyRows(courseId: number, userId: string): AsyncIterable<ChatHistoryExportRow>;
  verifyFeedbackToken(logId: number, shareSlug: string, token?: string): Promise<boolean>;
}

export function createChatHistoryService(deps: ChatHistoryDependencies) {
  async function exportHistoryCsv(
    courseId: number,
    userId: string,
  ): Promise<{ notFound: true } | { rows: AsyncIterable<ChatHistoryExportRow>; filename: string }> {
    if (!(await deps.courseOwnedBy(courseId, userId))) {
      return { notFound: true } as const;
    }
    return {
      rows: deps.historyRows(courseId, userId),
      filename: `chat_history_course_${courseId}.csv`,
    } as const;
  }

  async function submitFeedback(
    logId: number,
    feedback: "good" | "bad" | null,
    opts: { userId?: string; shareSlug?: string | null; feedbackToken?: string },
  ) {
    const error = opts.shareSlug == null ? null : textValueFailure(opts.shareSlug);
    if (error) throw validationFailure(error);
    if (opts.shareSlug && !await deps.verifyFeedbackToken(logId, opts.shareSlug, opts.feedbackToken)) {
      return { forbidden: "Invalid feedback token" } as const;
    }
    const updated = await deps.chat.feedback(logId, feedback, opts);
    if ("notFound" in updated) return { notFound: "Specified chat history not found" } as const;
    if ("forbidden" in updated) {
      return { forbidden: opts.shareSlug ? "Share token mismatch" : "No permission to access this history" } as const;
    }
    return {
      ok: true as const,
      chat_log_id: updated.id,
      feedback: updated.feedback,
    };
  }

  return {
    exportHistoryCsv, submitFeedback,
    async shareSlugExists(slug: string) {
      const error = textValueFailure(slug);
      if (error) throw validationFailure(error);
      return deps.chat.shareExists(slug);
    },
    historyForCourse: (courseId: number, userId: string, limit: number, offset: number) => deps.chat.history(courseId, userId, limit, offset),
    resetHistory: (courseId: number, userId: string) => deps.chat.deleteHistory(courseId, userId),
    analyticsForCourse: (courseId: number, userId: string) => deps.chat.analytics(courseId, userId),
  };
}
