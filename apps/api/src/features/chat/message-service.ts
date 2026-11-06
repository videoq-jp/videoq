import {
  getCourseWithMembers,
  createChatLog,
  createChatLogWithDb,
  type GroupChatContext,
} from "../../repositories/chat-repository";
import {
  releaseAiAnswerReservation,
  reserveAiAnswerUsage,
  type AiAnswerReservation,
} from "../../repositories/quota-repository";
import { LlmConfigurationError } from "../../lib/openai";
import {
  AnswerCostLedger,
  startAnswerCostLedger,
  finishAnswerCostLedger,
  type AnswerAttemptStatus,
} from "../../lib/answer-cost-ledger";
import type { RagResult } from "../../lib/rag";
import type { Db } from "../../db/pool";
import { runChatRag, streamChatRag, ConversationCommitError } from "../../lib/conversation-execution";
import { ConversationBusyError, ConversationNotFoundError } from "../../repositories/conversation-repository";
import { createChatFeedbackToken } from "../../lib/chat-feedback-token";
import { type ChatAnswer, type ChatStreamEvent } from "@videoq/trpc/chat";
import type { Bindings } from "../../types/bindings";
import type { ChatMessageBody } from "./schemas";
import type { ChatMessage } from "@videoq/trpc";
import { checkedLtiSubject, type LtiDataSubject } from '../lti/identity';

type ChatSendResult =
  | { status: 200; body: ChatMessage }
  | {
      status: ChatFailure["status"];
      body: { error: { code: string; message: string } };
    };

/** Normalized chat request after Zod validation. */
type ChatRequestInput = {
  messages: { role: string; content: string }[];
  courseId: number | null;
  conversationId?: string;
  resumeConversation?: boolean;
};

/** ドメイン例外に対応するエラー記述。ストリーム/非ストリームで表現を変える。 */
type ChatFailure = {
  streamCode: string;
  status: 400 | 403 | 404 | 500;
  code: string;
  message: string;
};

const failures = {
  invalidRequest: (message: string): ChatFailure => ({
    streamCode: "INVALID_REQUEST",
    status: 400,
    code: "VALIDATION_ERROR",
    message,
  }),
  notFound: (entity: string): ChatFailure => ({
    streamCode: "NOT_FOUND",
    status: 404,
    code: "VALIDATION_ERROR",
    message: `${entity} not found.`,
  }),
  permissionDenied: (message: string): ChatFailure => ({
    streamCode: "PERMISSION_DENIED",
    status: 403,
    code: "VALIDATION_ERROR",
    message,
  }),
  overQuota: (): ChatFailure => ({
    streamCode: "OVER_QUOTA",
    status: 403,
    code: "OVER_QUOTA",
    message:
      "AI chat is unavailable: account storage is over the configured limit.",
  }),
  answersLimit: (limit: number): ChatFailure => ({
    streamCode: "AI_ANSWERS_LIMIT_EXCEEDED",
    status: 400,
    code: "AI_ANSWERS_LIMIT_EXCEEDED",
    message: `AI answers limit exceeded. Limit: ${limit}.`,
  }),
  llmConfiguration: (message: string): ChatFailure => ({
    streamCode: "LLM_CONFIGURATION_ERROR",
    status: 400,
    code: "VALIDATION_ERROR",
    message,
  }),
  llmProvider: (): ChatFailure => ({
    streamCode: "LLM_PROVIDER_ERROR",
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An internal server error occurred.",
  }),
};

type ChatSetup = {
  ownerUserId: string;
  actorUserId: string;
  quotaReservation: AiAnswerReservation;
  course: GroupChatContext | null;
  isShared: boolean;
  locale: string | null;
  ltiSubject?: LtiDataSubject;
  displayQuestion?: string;
};

function toChatRequestInput(body: ChatMessageBody): ChatRequestInput {
  return {
    messages: body.messages,
    courseId: body.course_id ?? null,
    conversationId: body.conversation_id,
    resumeConversation: body.resume_conversation,
  };
}

/** LLM 呼び出し前の共通セットアップ（course/owner/quota）。 */
async function setupChat(
  env: Bindings,
  opts: {
    userId: string | null;
    req: ChatRequestInput;
    shareSlug: string | null;
    locale: string | null;
    ltiCourseGrant?: number;
    ltiVideoGrant?: number[];
    ltiSubjectKey?: string;
    displayQuestion?: string;
  },
): Promise<{ ok: true; setup: ChatSetup } | { ok: false; failure: ChatFailure }> {
  const isShared = opts.shareSlug !== null || opts.ltiCourseGrant !== undefined;
  const userId = opts.userId;

  if (opts.req.messages.length === 0) {
    return { ok: false, failure: failures.invalidRequest("Messages are empty.") };
  }
  if (isShared && opts.req.courseId === null) {
    return {
      ok: false,
      failure: failures.invalidRequest("Course ID not specified."),
    };
  }

  let course: GroupChatContext | null = null;
  if (opts.req.courseId !== null) {
    course = await getCourseWithMembers(env, {
      courseId: opts.req.courseId,
      userId: isShared ? null : userId,
      shareToken: opts.shareSlug,
      ltiCourseGrant: opts.ltiCourseGrant,
      ltiVideoGrant: opts.ltiVideoGrant,
    });
    if (!course) return { ok: false, failure: failures.notFound("Course") };
  }

  const ownerUserId = course?.userId ?? userId;
  if (opts.ltiSubjectKey && (opts.ltiCourseGrant !== course?.id || userId !== null || opts.shareSlug !== null)) {
    return { ok: false, failure: failures.permissionDenied('Invalid external identity scope.') };
  }
  const ltiSubject = opts.ltiSubjectKey ? checkedLtiSubject({ subjectKey: opts.ltiSubjectKey, resourceVideoIds: course!.memberVideoIds }) : undefined;
  if (ownerUserId === null) {
    return {
      ok: false,
      failure: failures.permissionDenied(
        "Authentication is required to send messages.",
      ),
    };
  }

  const quota = await reserveAiAnswerUsage(env, ownerUserId);
  if ("overQuota" in quota) return { ok: false, failure: failures.overQuota() };
  if ("exceeded" in quota) {
    return { ok: false, failure: failures.answersLimit(quota.limit) };
  }

  return {
    ok: true,
    setup: {
      ownerUserId,
      actorUserId: isShared ? ownerUserId : (userId ?? ownerUserId),
      quotaReservation: quota.reservation,
      course,
      isShared,
      locale: opts.locale,
      ...(ltiSubject ? { ltiSubject } : {}),
      ...(opts.displayQuestion !== undefined ? { displayQuestion: opts.displayQuestion } : {}),
    },
  };
}

const toFailure = (e: unknown): ChatFailure => {
  if (e instanceof ConversationNotFoundError) {
    return { streamCode: 'CONVERSATION_NOT_FOUND', status: 404, code: 'CONVERSATION_NOT_FOUND', message: e.message };
  }
  if (e instanceof ConversationBusyError) {
    return { streamCode: "CONVERSATION_BUSY", status: 400, code: "CONVERSATION_BUSY", message: e.message };
  }
  if (e instanceof LlmConfigurationError) {
    return failures.llmConfiguration(e.message);
  }
  return failures.llmProvider();
};

async function persistTurn(
  env: Bindings,
  setup: ChatSetup,
  turn: {
    question: string;
    answer: ChatAnswer;
    retrievedContexts: string[];
  },
  db?: Db,
): Promise<{ chatLogId: number | null; feedback: string | null }> {
  if (!setup.course) return { chatLogId: null, feedback: null };
  const log = await (db ? createChatLogWithDb.bind(null, db) : createChatLog.bind(null, env))({
    userId: setup.actorUserId,
    courseId: setup.course.id,
    question: setup.displayQuestion ?? turn.question,
    answer: turn.answer,
    isShared: setup.isShared,
    retrievedContexts: turn.retrievedContexts,
    ...(setup.ltiSubject ? { ltiSubject: setup.ltiSubject } : {}),
  });
  return { chatLogId: log.id, feedback: log.feedback };
}

async function releaseReservedUsage(env: Bindings, setup: ChatSetup): Promise<void> {
  try {
    await releaseAiAnswerReservation(env, setup.quotaReservation);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "ai_answer_quota_release_failed",
        ownerUserId: setup.ownerUserId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function finishCostLedger(
  env: Bindings, ledger: AnswerCostLedger, status: AnswerAttemptStatus, quotaConsumed: boolean,
): Promise<void> {
  try {
    await finishAnswerCostLedger(env, ledger, { status, quotaConsumed });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error", event: "ai_answer_cost_ledger_finish_failed", attemptId: ledger.id,
      errorType: error instanceof Error ? error.name : "unknown",
    }));
  }
}

async function startCostLedger(env: Bindings, setup: ChatSetup, hasCourse: boolean, streamed: boolean) {
  const ledger = new AnswerCostLedger();
  try {
    await startAnswerCostLedger(env, ledger, {
      planCode: setup.quotaReservation.planCode,
      quotaSource: setup.quotaReservation.quotaSource,
      hasCourse,
      streamed,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error", event: "ai_answer_cost_ledger_start_failed", attemptId: ledger.id,
      errorType: error instanceof Error ? error.name : "unknown",
    }));
  }
  return ledger;
}

export function requestLocaleFromHeader(
  acceptLanguage: string | undefined,
): string | null {
  const header = acceptLanguage ?? "";
  if (!header) return null;
  return header.split(",")[0].split(";")[0].trim() || null;
}

/** Non-streaming `chat.send` procedure. */
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
    displayQuestion?: string;
  },
): Promise<ChatSendResult> {
  const req = toChatRequestInput(opts.body);

  const prepared = await setupChat(env, {
    userId: opts.userId,
    req,
    shareSlug: opts.shareSlug,
    locale: opts.locale,
    ltiCourseGrant: opts.ltiCourseGrant,
    ltiVideoGrant: opts.ltiVideoGrant,
    ltiSubjectKey: opts.ltiSubjectKey,
    displayQuestion: opts.displayQuestion,
  });
  if (!prepared.ok) {
    const f = prepared.failure;
    return {
      status: f.status,
      body: { error: { code: f.code, message: f.message } },
    };
  }

  const setup = prepared.setup;
  const videoIds = setup.course ? setup.course.memberVideoIds : null;

  const costLedger = await startCostLedger(env, setup, setup.course !== null, false);

  let result: RagResult;
  try {
    result = await runChatRag(env, {
      messages: req.messages,
      ownerUserId: setup.ownerUserId,
      videoIds,
      locale: setup.locale,
      courseId: setup.course?.id ?? null,
      costLedger,
    }, {
      id: req.conversationId,
      resume: req.resumeConversation,
      question: setup.displayQuestion,
      persistLog: (answer, db) => persistTurn(env, setup, { question: answer.queryText, answer: answer.answer, retrievedContexts: answer.retrievedContexts }, db),
      scope: { ownerUserId: setup.ownerUserId, actorUserId: opts.shareSlug ? null : opts.userId,
        courseId: setup.course?.id ?? null, shareSlug: opts.shareSlug, visitorSessionId: opts.visitorSessionId, ...(setup.ltiSubject ? { ltiSubject: setup.ltiSubject } : {}) },
    });
  } catch (e) {
    const consumed = e instanceof ConversationCommitError;
    if (!consumed) await releaseReservedUsage(env, setup);
    await finishCostLedger(env, costLedger, "failed", consumed);
    const f = toFailure(e);
    return {
      status: f.status,
      body: { error: { code: f.code, message: f.message } },
    };
  }

  try {
    const { chatLogId, feedback } = result.persistedTurn ?? await persistTurn(env, setup, {
      question: result.queryText,
      answer: result.answer,
      retrievedContexts: result.retrievedContexts,
    });

    const body: ChatMessage = {
      role: "assistant",
      answer: result.answer,
    };
    if (chatLogId !== null) {
      body.chat_log_id = chatLogId;
      body.feedback = feedback === "good" || feedback === "bad" ? feedback : null;
      if (opts.shareSlug) body.feedback_token = await createChatFeedbackToken(env, chatLogId, opts.shareSlug);
    }

    await finishCostLedger(env, costLedger, "completed", true);

    return { status: 200, body };
  } catch (e) {
    await finishCostLedger(env, costLedger, "failed", true);
    const f = toFailure(e);
    return {
      status: f.status,
      body: { error: { code: f.code, message: f.message } },
    };
  }
}

export type SseEventWriter = (data: ChatStreamEvent) => Promise<void>;

/** POST /api/chat/messages/stream */
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
    displayQuestion?: string;
    clientSignal?: AbortSignal;
    includeToolProgress?: boolean;
  },
): Promise<{ write: (send: SseEventWriter) => Promise<void> }> {
  const req = toChatRequestInput(opts.body);

  const prepared = await setupChat(env, {
    userId: opts.userId,
    req,
    shareSlug: opts.shareSlug,
    locale: opts.locale,
    ltiCourseGrant: opts.ltiCourseGrant,
    ltiVideoGrant: opts.ltiVideoGrant,
    ltiSubjectKey: opts.ltiSubjectKey,
    displayQuestion: opts.displayQuestion,
  });

  const messages = req.messages;
  const clientSignal = opts.clientSignal;

  return {
    async write(send) {
      if (!prepared.ok) {
        const failure = prepared.failure;
        await send({
          type: "error",
          code: failure.streamCode,
          message: failure.message,
        });
        return;
      }
      const setup = prepared.setup;
      const videoIds = setup.course ? setup.course.memberVideoIds : null;

      const costLedger = await startCostLedger(env, setup, setup.course !== null, true);

      let generatedContent = false;
      let final: RagResult | undefined;

      try {
        for await (const chunk of streamChatRag(
          env,
          {
            messages,
            ownerUserId: setup.ownerUserId,
            videoIds,
            locale: setup.locale,
            courseId: setup.course?.id ?? null,
            costLedger,
          },
          {
            id: req.conversationId,
            resume: req.resumeConversation,
            question: setup.displayQuestion,
            persistLog: (answer, db) => persistTurn(env, setup, { question: answer.queryText, answer: answer.answer, retrievedContexts: answer.retrievedContexts }, db),
            scope: { ownerUserId: setup.ownerUserId, actorUserId: opts.shareSlug ? null : opts.userId,
              courseId: setup.course?.id ?? null, shareSlug: opts.shareSlug, visitorSessionId: opts.visitorSessionId, ...(setup.ltiSubject ? { ltiSubject: setup.ltiSubject } : {}) },
          },
          clientSignal,
        )) {
          if ("part" in chunk) {
            const part = chunk.part;
            generatedContent ||= part.type === "text" && part.text.length > 0;
            await send(part.type === "text"
              ? { ...part, type: "text_delta" }
              : part);
          } else if ("source" in chunk) {
            await send({ type: "source", source: chunk.source });
          } else if ("toolProgress" in chunk) {
            // Older open tabs validate SSE events strictly. Keep their stream
            // compatible until they reload into a client supporting tool activity.
            if (opts.includeToolProgress) await send(chunk.toolProgress);
          } else if ("searching" in chunk) {
            // 検索ラウンドの間はトークンが流れないので、進行中であることだけ伝える。
            await send({ type: "searching", query: chunk.searching, search_id: chunk.searchId });
          } else if ("searchCompleted" in chunk) {
            await send({
              type: "search_completed",
              search_id: chunk.searchCompleted.id,
              query: chunk.searchCompleted.query,
              result_count: chunk.searchCompleted.count,
            });
          } else {
            final = chunk.final;
          }
        }
        if (!final) throw new Error("Missing completed structured answer");
      } catch (error) {
        // 一部でも回答を生成済みなら、上流LLMの実コストも消費済みなので返却しない。
        if (!generatedContent) await releaseReservedUsage(env, setup);
        await finishCostLedger(env, costLedger, clientSignal?.aborted ? "interrupted" : "failed", generatedContent);
        const failure = toFailure(error);
        await send({
          type: "error",
          code: failure.streamCode,
          message: failure.message,
        });
        return;
      }

      let chatLogId: number | null;
      let feedback: string | null;
      try {
        ({ chatLogId, feedback } = final.persistedTurn ?? await persistTurn(env, setup, {
          question: final.queryText,
          answer: final.answer,
          retrievedContexts: final.retrievedContexts,
        }));
      } catch (error) {
        await finishCostLedger(env, costLedger, "failed", true);
        const failure = toFailure(error);
        await send({
          type: "error",
          code: failure.streamCode,
          message: failure.message,
        });
        return;
      }

      const done: Extract<ChatStreamEvent, { type: "done" }> = {
        type: "done",
        chat_log_id: chatLogId,
        feedback: feedback === "good" || feedback === "bad" ? feedback : null,
        ...(opts.shareSlug && chatLogId !== null
          ? { feedback_token: await createChatFeedbackToken(env, chatLogId, opts.shareSlug) }
          : {}),
      };
      await finishCostLedger(env, costLedger, "completed", true);
      await send(done);
    },
  };
}
