import {
  getCourseWithMembers,
  createChatLog,
} from "../repositories/chat-repository";
import {
  releaseAiAnswerReservation,
  reserveAiAnswerUsage,
  type AiAnswerReservation,
} from "../repositories/quota-repository";
import { LlmConfigurationError } from "../lib/openai";
import {
  AnswerCostLedger,
  startAnswerCostLedger,
  finishAnswerCostLedger,
  type AnswerAttemptStatus,
} from "../lib/answer-cost-ledger";
import {
  runChatRag,
  streamChatRag,
  ConversationCommitError,
} from "../lib/conversation-execution";
import {
  ConversationBusyError,
  ConversationNotFoundError,
} from "../repositories/conversation-repository";
import { createChatFeedbackToken } from "../lib/chat-feedback-token";
import type { Bindings } from "../types/bindings";
import { checkedLtiSubject } from "../features/lti/identity";

import { createChatGenerationService } from "../features/chat/generation-service";
import type { ChatFailure } from "../features/chat/generation-ports";

const toFailure = (e: unknown): ChatFailure => {
  if (e instanceof ConversationNotFoundError) {
    return {
      streamCode: "CONVERSATION_NOT_FOUND",
      kind: "missing",
      code: "CONVERSATION_NOT_FOUND",
      message: e.message,
    };
  }
  if (e instanceof ConversationBusyError) {
    return {
      streamCode: "CONVERSATION_BUSY",
      kind: "invalid",
      code: "CONVERSATION_BUSY",
      message: e.message,
    };
  }
  if (e instanceof LlmConfigurationError) {
    return {
      kind: "invalid",
      streamCode: "LLM_CONFIGURATION_ERROR",
      code: "VALIDATION_ERROR",
      message: e.message,
    };
  }
  return {
    kind: "internal",
    streamCode: "LLM_PROVIDER_ERROR",
    code: "INTERNAL_ERROR",
    message: "An internal server error occurred.",
  };
};

async function releaseReservedUsage(
  env: Bindings,
  reservation: AiAnswerReservation,
): Promise<void> {
  try {
    await releaseAiAnswerReservation(env, reservation);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "ai_answer_quota_release_failed",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

async function finishCostLedger(
  env: Bindings,
  ledger: AnswerCostLedger,
  status: AnswerAttemptStatus,
  quotaConsumed: boolean,
): Promise<void> {
  try {
    await finishAnswerCostLedger(env, ledger, { status, quotaConsumed });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "ai_answer_cost_ledger_finish_failed",
        attemptId: ledger.id,
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

async function startCostLedger(
  env: Bindings,
  reservation: AiAnswerReservation,
  hasCourse: boolean,
  streamed: boolean,
) {
  const ledger = new AnswerCostLedger();
  try {
    await startAnswerCostLedger(env, ledger, {
      planCode: reservation.planCode,
      quotaSource: reservation.quotaSource,
      hasCourse,
      streamed,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "ai_answer_cost_ledger_start_failed",
        attemptId: ledger.id,
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
  return ledger;
}

export function chatGenerationService(env: Bindings) {
  return createChatGenerationService({
    context: (input) => getCourseWithMembers(env, input),
    checkedLtiSubject,
    reserve: (userId) => reserveAiAnswerUsage(env, userId),
    release: (reservation) => releaseReservedUsage(env, reservation),
    createLog: (input) => createChatLog(env, input),
    startCost: (reservation, hasCourse, streamed) =>
      startCostLedger(env, reservation, hasCourse, streamed),
    finishCost: (ledger, status, consumed) =>
      finishCostLedger(env, ledger, status, consumed),
    run: (params, conversation) => runChatRag(env, params, conversation),
    stream: (params, conversation, signal) =>
      streamChatRag(env, params, conversation, signal),
    isCommittedFailure: (error) => error instanceof ConversationCommitError,
    classifyFailure: toFailure,
    feedbackToken: (id, slug) => createChatFeedbackToken(env, id, slug),
  });
}
