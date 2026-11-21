import type { LtiSessionProof } from "../../application/lti-session-proof";
import type { Bindings } from "../../types/bindings";
import type { ChatMessageBody } from "./schemas";
import type { ChatMessage } from "@videoq/trpc";
import type { ChatStreamEvent } from "@videoq/trpc/chat";
import type {
  ChatFailure,
  ChatRequestInput,
  ChatGenerationEvent,
} from "./generation-ports";
import { chatGenerationService } from "../../integrations/chat-generation";

type FailureStatus = 400 | 403 | 404 | 500;
type ChatSendResult =
  | { status: 200; body: ChatMessage }
  | {
      status: FailureStatus;
      body: { error: { code: string; message: string } };
    };
const failureStatus = (failure: ChatFailure): FailureStatus =>
  (({ invalid: 400, forbidden: 403, missing: 404, internal: 500 }) as const)[
    failure.kind
  ];
function toChatRequestInput(body: ChatMessageBody): ChatRequestInput {
  return {
    messages: body.messages,
    courseId: body.course_id ?? null,
    conversationId: body.conversation_id,
    resumeConversation: body.resume_conversation,
  };
}

export function requestLocaleFromHeader(
  acceptLanguage: string | undefined,
): string | null {
  const header = acceptLanguage ?? "";
  if (!header) return null;
  return header.split(",")[0].split(";")[0].trim() || null;
}

export async function sendChatMessage(
  env: Bindings,
  opts: {
    userId: string | null;
    body: ChatMessageBody;
    visitorSessionId?: string;
    shareSlug: string | null;
    locale: string | null;
    /** Internal course-scoped grant; never accepted from ordinary chat input. */
    ltiCourseGrant?: number;
    ltiVideoGrant?: number[];
    ltiSubjectKey?: string;
    ltiSessionProof?: LtiSessionProof;
    displayQuestion?: string;
  },
): Promise<ChatSendResult> {
  const { body, ...options } = opts;
  const result = await chatGenerationService(env).send({
    ...options,
    request: toChatRequestInput(body),
  });
  if (!result.ok)
    return {
      status: failureStatus(result.failure),
      body: {
        error: { code: result.failure.code, message: result.failure.message },
      },
    };
  const { chatLogId, feedbackToken, ...message } = result.message;
  return {
    status: 200,
    body: {
      ...message,
      ...(chatLogId !== undefined ? { chat_log_id: chatLogId } : {}),
      ...(feedbackToken !== undefined ? { feedback_token: feedbackToken } : {}),
    },
  };
}

export type SseEventWriter = (data: ChatStreamEvent) => Promise<void>;
function toStreamEvent(event: ChatGenerationEvent): ChatStreamEvent {
  switch (event.type) {
    case "error":
      return {
        type: "error",
        code: event.failure.streamCode,
        message: event.failure.message,
      };
    case "text":
      return { ...event, type: "text_delta" };
    case "searching":
      return {
        type: "searching",
        query: event.query,
        search_id: event.searchId,
      };
    case "searchCompleted":
      return {
        type: "search_completed",
        query: event.query,
        search_id: event.searchId,
        result_count: event.count,
      };
    case "done":
      return {
        type: "done",
        chat_log_id: event.chatLogId,
        feedback: event.feedback,
        ...(event.feedbackToken !== undefined
          ? { feedback_token: event.feedbackToken }
          : {}),
      };
    default:
      return event;
  }
}

export async function streamChatMessage(
  env: Bindings,
  opts: {
    userId: string | null;
    body: ChatMessageBody;
    visitorSessionId?: string;
    shareSlug: string | null;
    locale: string | null;
    ltiCourseGrant?: number;
    ltiVideoGrant?: number[];
    ltiSubjectKey?: string;
    ltiSessionProof?: LtiSessionProof;
    displayQuestion?: string;
    clientSignal?: AbortSignal;
    includeToolProgress?: boolean;
    includeGenerationProgress?: boolean;
  },
): Promise<{ write: (send: SseEventWriter) => Promise<void> }> {
  const { body, includeToolProgress, includeGenerationProgress, ...options } = opts;
  const result = await chatGenerationService(env).stream({
    ...options,
    request: toChatRequestInput(body),
  });
  return {
    write: (send) =>
      result.write(async (event) => {
        // Older clients reject unknown SSE events until they reload.
        if (event.type === "tool_progress" && !includeToolProgress) return;
        if (event.type === "generation_progress" && !includeGenerationProgress) return;
        await send(toStreamEvent(event));
      }),
  };
}
