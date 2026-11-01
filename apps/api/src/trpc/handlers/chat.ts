import type { Context } from "hono";
import * as chatService from "../../features/chat/service";
import * as messageService from "../../features/chat/message-service";
import { chatThrottleChecks, enforceThrottles } from "../../lib/rate-limit";
import type { AppEnv } from "../../types/bindings";
import { apiStatusToTrpcCode, requireUserId, rpcError, type HandlersFor } from "./shared";

async function enforceChatThrottle(
  c: Context<AppEnv>,
  userId: string | null,
  shareSlug?: string,
) {
  const denied = await enforceThrottles(c.env, chatThrottleChecks(c, userId, shareSlug));
  if (denied) {
    return rpcError(
      "TOO_MANY_REQUESTS",
      `Request was throttled. Expected available in ${denied.retryAfterSec} seconds.`,
      { appCode: "LIMIT_EXCEEDED" },
    );
  }
}

export function chatHandlers(
  c: Context<AppEnv>,
  authenticatedUserId: string | null,
): HandlersFor<"chat"> {
  const userId = () => requireUserId(authenticatedUserId);
  return {
    "chat.send": async ({ messages, courseId, shareSlug }) => {
      if (authenticatedUserId === null && !shareSlug) {
        return rpcError("UNAUTHORIZED", "Authentication credentials were not provided.", {
          appCode: "UNAUTHORIZED",
        });
      }
      await enforceChatThrottle(c, authenticatedUserId, shareSlug);
      const result = await messageService.sendChatMessage(c.env, {
        userId: authenticatedUserId,
        body: {
          messages,
          course_id: courseId,
        },
        shareSlug: shareSlug ?? null,
        locale: messageService.requestLocaleFromHeader(c.req.header("Accept-Language")),
      });
      if (result.status !== 200) {
        const error = result.body.error;
        return rpcError(apiStatusToTrpcCode(result.status), error.message, {
          appCode: error.code,
        });
      }
      return result.body;
    },
    "chat.feedback": async ({ chatLogId, feedback, shareSlug, feedbackToken }) => {
      if (authenticatedUserId === null && !shareSlug) {
        return rpcError("UNAUTHORIZED", "Authentication credentials were not provided.");
      }
      const result = await chatService.submitFeedback(c.env, chatLogId, feedback, {
        userId: authenticatedUserId ?? undefined,
        shareSlug,
        feedbackToken,
      });
      if ("notFound" in result) return rpcError("NOT_FOUND", result.notFound ?? "Not found");
      if ("forbidden" in result) return rpcError("FORBIDDEN", result.forbidden ?? "Forbidden");
      return { chat_log_id: result.chat_log_id, feedback: result.feedback };
    },
    "chat.history": async ({ courseId, limit, offset }) => {
      const result = await chatService.historyForCourse(c.env, courseId, userId(), limit, offset);
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found.");
      return { data: result.results, meta: { total: result.count, limit, offset } };
    },
    "chat.resetHistory": async ({ courseId }) => {
      const result = await chatService.resetHistory(c.env, courseId, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found.");
      return { success: true };
    },
    "chat.analytics": async ({ courseId }) => {
      const result = await chatService.analyticsForCourse(c.env, courseId, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found.");
      return result;
    },
  };
}
