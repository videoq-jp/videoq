import { aiQuotaConsumed } from '../../domain/billing/ai-consumption';
import type { CancellationState } from '../../domain/conversation/answer-generation';
import { validConversationQuestion } from '@videoq/domain/chat';
import { textValueFailure } from '@videoq/domain/text-value';
import type { ChatAnswer } from "../../application/models";
import type { LtiSessionProof } from "../../application/lti-session-proof";
import type { AiAnswerReservation } from "../../persistence/contracts/ai-quota";
import type {
  GroupChatContext,
  CreateChatLogInput,
} from "../../persistence/contracts/chat-repository";
import type { LtiDataSubject } from "../../persistence/contracts/lti-subject";
import type {
  ChatGenerationDependencies,
  ChatFailure,
  ChatRequestInput,
  GeneratedAnswer,
  ChatGenerationEvent,
  ChatMessage,
  ChatGenerationOptions,
} from "./generation-ports";

/** Answer lifecycle. Runtime adapters and transport formatting are supplied outside. */
export function createChatGenerationService<Ledger, Signal extends CancellationState = CancellationState>(
  deps: ChatGenerationDependencies<Ledger, Signal>,
) {
  type ChatSendResult =
    | { ok: true; message: ChatMessage }
    | {
        ok: false;
        failure: ChatFailure;
      };

  /** Failures describe application outcomes; transport adapters select status codes. */
  const failures = {
    invalidRequest: (message: string): ChatFailure => ({
      streamCode: "INVALID_REQUEST",
      kind: "invalid",
      code: "VALIDATION_ERROR",
      message,
    }),
    notFound: (entity: string): ChatFailure => ({
      streamCode: "NOT_FOUND",
      kind: "missing",
      code: "VALIDATION_ERROR",
      message: `${entity} not found.`,
    }),
    permissionDenied: (message: string): ChatFailure => ({
      streamCode: "PERMISSION_DENIED",
      kind: "forbidden",
      code: "VALIDATION_ERROR",
      message,
    }),
    overQuota: (): ChatFailure => ({
      streamCode: "OVER_QUOTA",
      kind: "forbidden",
      code: "OVER_QUOTA",
      message:
        "AI chat is unavailable: account storage is over the configured limit.",
    }),
    answersLimit: (limit: number): ChatFailure => ({
      streamCode: "AI_ANSWERS_LIMIT_EXCEEDED",
      kind: "invalid",
      code: "AI_ANSWERS_LIMIT_EXCEEDED",
      message: `AI answers limit exceeded. Limit: ${limit}.`,
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

  /** LLM 呼び出し前の共通セットアップ（course/owner/quota）。 */
  async function setupChat(opts: {
    userId: string | null;
    req: ChatRequestInput;
    shareSlug: string | null;
    locale: string | null;
    ltiCourseGrant?: number;
    ltiVideoGrant?: number[];
    ltiSubjectKey?: string;
    ltiSessionProof?: LtiSessionProof;
    displayQuestion?: string;
  }): Promise<
    { ok: true; setup: ChatSetup } | { ok: false; failure: ChatFailure }
  > {
    const isShared =
      opts.shareSlug !== null || opts.ltiCourseGrant !== undefined;
    const userId = opts.userId;

    const shareError = opts.shareSlug === null ? null : textValueFailure(opts.shareSlug);
    if (shareError) return { ok: false, failure: failures.invalidRequest(shareError) };

    if (opts.req.messages.length === 0) {
      return {
        ok: false,
        failure: failures.invalidRequest("Messages are empty."),
      };
    }
    if (!validConversationQuestion(opts.req.messages, opts.req.conversationId)) {
      return { ok: false, failure: failures.invalidRequest('A conversation request requires one user question.') };
    }
    if (isShared && opts.req.courseId === null) {
      return {
        ok: false,
        failure: failures.invalidRequest("Course ID not specified."),
      };
    }

    let course: GroupChatContext | null = null;
    if (opts.req.courseId !== null) {
      course = await deps.context({
        courseId: opts.req.courseId,
        userId: isShared ? null : userId,
        shareToken: opts.shareSlug,
        ltiCourseGrant: opts.ltiCourseGrant,
        ltiVideoGrant: opts.ltiVideoGrant,
      });
      if (!course) return { ok: false, failure: failures.notFound("Course") };
    }

    const ownerUserId = course?.userId ?? userId;
    if (
      opts.ltiSubjectKey &&
      (opts.ltiCourseGrant !== course?.id ||
        userId !== null ||
        opts.shareSlug !== null)
    ) {
      return {
        ok: false,
        failure: failures.permissionDenied("Invalid external identity scope."),
      };
    }
    const ltiSubject = opts.ltiSubjectKey
      ? deps.checkedLtiSubject({
          subjectKey: opts.ltiSubjectKey,
          resourceVideoIds: course!.memberVideoIds,
          ...(opts.ltiSessionProof
            ? { sessionProof: opts.ltiSessionProof }
            : {}),
        })
      : undefined;
    if (ownerUserId === null) {
      return {
        ok: false,
        failure: failures.permissionDenied(
          "Authentication is required to send messages.",
        ),
      };
    }

    // Preserve authorization precedence while rejecting unpersistable input
    // before quota, model execution, cost accounting or conversation writes.
    const textError = opts.req.messages.map(message => textValueFailure(message.content)).find(Boolean)
      ?? (opts.displayQuestion === undefined ? null : textValueFailure(opts.displayQuestion));
    if (textError) return { ok: false, failure: failures.invalidRequest(textError) };

    const quota = await deps.reserve(ownerUserId);
    if ("overQuota" in quota)
      return { ok: false, failure: failures.overQuota() };
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
        ...(opts.displayQuestion !== undefined
          ? { displayQuestion: opts.displayQuestion }
          : {}),
      },
    };
  }

  function prepareTurnLog(
    setup: ChatSetup,
    turn: {
      question: string;
      answer: ChatAnswer;
      retrievedContexts: string[];
    },
  ): CreateChatLogInput | null {
    if (!setup.course) return null;
    return {
      userId: setup.actorUserId,
      courseId: setup.course.id,
      question: setup.displayQuestion ?? turn.question,
      answer: turn.answer,
      isShared: setup.isShared,
      retrievedContexts: turn.retrievedContexts,
      ...(setup.ltiSubject ? { ltiSubject: setup.ltiSubject } : {}),
    };
  }

  async function persistTurn(
    setup: ChatSetup,
    turn: { question: string; answer: ChatAnswer; retrievedContexts: string[] },
  ) {
    const input = prepareTurnLog(setup, turn);
    if (!input) return { chatLogId: null, feedback: null };
    const log = await deps.createLog(input);
    return { chatLogId: log.id, feedback: log.feedback };
  }

  /** Generate and persist one answer. */
  async function sendChatMessage(
    opts: ChatGenerationOptions,
  ): Promise<ChatSendResult> {
    const req = opts.request;

    const prepared = await setupChat({
      userId: opts.userId,
      req,
      shareSlug: opts.shareSlug,
      locale: opts.locale,
      ltiCourseGrant: opts.ltiCourseGrant,
      ltiVideoGrant: opts.ltiVideoGrant,
      ltiSubjectKey: opts.ltiSubjectKey,
      ltiSessionProof: opts.ltiSessionProof,
      displayQuestion: opts.displayQuestion,
    });
    if (!prepared.ok) {
      const f = prepared.failure;
      return {
        ok: false,
        failure: f,
      };
    }

    const setup = prepared.setup;
    const videoIds = setup.course ? setup.course.memberVideoIds : null;

    const costLedger = await deps.startCost(
      setup.quotaReservation,
      setup.course !== null,
      false,
    );

    let result: GeneratedAnswer;
    try {
      result = await deps.run(
        {
          messages: req.messages,
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
          persistLog: (answer) =>
            prepareTurnLog(setup, {
              question: answer.queryText,
              answer: answer.answer,
              retrievedContexts: answer.retrievedContexts,
            }),
          scope: {
            ownerUserId: setup.ownerUserId,
            actorUserId: opts.shareSlug ? null : opts.userId,
            courseId: setup.course?.id ?? null,
            shareSlug: opts.shareSlug,
            visitorSessionId: opts.visitorSessionId,
            ...(setup.ltiSubject ? { ltiSubject: setup.ltiSubject } : {}),
          },
        },
      );
    } catch (e) {
      const consumed = aiQuotaConsumed({ kind: 'failed_answer', committed: deps.isCommittedFailure(e) });
      if (!consumed) await deps.release(setup.quotaReservation);
      await deps.finishCost(costLedger, "failed", consumed);
      const f = deps.classifyFailure(e);
      return {
        ok: false,
        failure: f,
      };
    }

    try {
      const { chatLogId, feedback } =
        result.persistedTurn ??
        (await persistTurn(setup, {
          question: result.queryText,
          answer: result.answer,
          retrievedContexts: result.retrievedContexts,
        }));

      const body: ChatMessage = {
        role: "assistant",
        answer: result.answer,
      };
      if (chatLogId !== null) {
        body.chatLogId = chatLogId;
        body.feedback =
          feedback === "good" || feedback === "bad" ? feedback : null;
        if (opts.shareSlug)
          body.feedbackToken = await deps.feedbackToken(
            chatLogId,
            opts.shareSlug,
          );
      }

      await deps.finishCost(costLedger, "completed", aiQuotaConsumed({ kind: 'completed_answer' }));

      return { ok: true, message: body };
    } catch (e) {
      await deps.finishCost(costLedger, "failed", aiQuotaConsumed({ kind: 'completed_answer' }));
      const f = deps.classifyFailure(e);
      return {
        ok: false,
        failure: f,
      };
    }
  }

  type EventWriter = (data: ChatGenerationEvent) => Promise<void>;

  /** Stream generation progress while preserving quota and persistence semantics. */
  async function streamChatMessage(
    opts: ChatGenerationOptions & { clientSignal?: Signal },
  ): Promise<{ write: (send: EventWriter) => Promise<void> }> {
    const req = opts.request;

    const prepared = await setupChat({
      userId: opts.userId,
      req,
      shareSlug: opts.shareSlug,
      locale: opts.locale,
      ltiCourseGrant: opts.ltiCourseGrant,
      ltiVideoGrant: opts.ltiVideoGrant,
      ltiSubjectKey: opts.ltiSubjectKey,
      ltiSessionProof: opts.ltiSessionProof,
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
            failure,
          });
          return;
        }
        const setup = prepared.setup;
        const videoIds = setup.course ? setup.course.memberVideoIds : null;

        const costLedger = await deps.startCost(
          setup.quotaReservation,
          setup.course !== null,
          true,
        );

        let generatedContent = false;
        let final: GeneratedAnswer | undefined;

        try {
          for await (const chunk of deps.stream(
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
              persistLog: (answer) =>
                prepareTurnLog(setup, {
                  question: answer.queryText,
                  answer: answer.answer,
                  retrievedContexts: answer.retrievedContexts,
                }),
              scope: {
                ownerUserId: setup.ownerUserId,
                actorUserId: opts.shareSlug ? null : opts.userId,
                courseId: setup.course?.id ?? null,
                shareSlug: opts.shareSlug,
                visitorSessionId: opts.visitorSessionId,
                ...(setup.ltiSubject ? { ltiSubject: setup.ltiSubject } : {}),
              },
            },
            clientSignal,
          )) {
            if ("part" in chunk) {
              const part = chunk.part;
              generatedContent ||= part.type === "text" && part.text.length > 0;
              await send(part);
            } else if ("source" in chunk) {
              await send({ type: "source", source: chunk.source });
            } else if ("generationProgress" in chunk) {
              await send(chunk.generationProgress);
            } else if ("toolProgress" in chunk) {
              await send(chunk.toolProgress);
            } else if ("searching" in chunk) {
              // 検索ラウンドの間はトークンが流れないので、進行中であることだけ伝える。
              await send({
                type: "searching",
                query: chunk.searching,
                searchId: chunk.searchId,
              });
            } else if ("searchCompleted" in chunk) {
              await send({
                type: "searchCompleted",
                searchId: chunk.searchCompleted.id,
                query: chunk.searchCompleted.query,
                count: chunk.searchCompleted.count,
              });
            } else {
              final = chunk.final;
            }
          }
          if (!final) throw new Error("Missing completed structured answer");
        } catch (error) {
          // 一部でも回答を生成済みなら、上流LLMの実コストも消費済みなので返却しない。
          const consumed = aiQuotaConsumed({ kind: 'interrupted_stream', textGenerated: generatedContent });
          if (!consumed) await deps.release(setup.quotaReservation);
          await deps.finishCost(
            costLedger,
            clientSignal?.aborted ? "interrupted" : "failed",
            consumed,
          );
          const failure = deps.classifyFailure(error);
          await send({
            type: "error",
            failure,
          });
          return;
        }

        let chatLogId: number | null;
        let feedback: string | null;
        try {
          ({ chatLogId, feedback } =
            final.persistedTurn ??
            (await persistTurn(setup, {
              question: final.queryText,
              answer: final.answer,
              retrievedContexts: final.retrievedContexts,
            })));
        } catch (error) {
          await deps.finishCost(costLedger, "failed", aiQuotaConsumed({ kind: 'completed_answer' }));
          const failure = deps.classifyFailure(error);
          await send({
            type: "error",
            failure,
          });
          return;
        }

        const done: Extract<ChatGenerationEvent, { type: "done" }> = {
          type: "done",
          chatLogId: chatLogId,
          feedback: feedback === "good" || feedback === "bad" ? feedback : null,
          ...(opts.shareSlug && chatLogId !== null
            ? {
                feedbackToken: await deps.feedbackToken(
                  chatLogId,
                  opts.shareSlug,
                ),
              }
            : {}),
        };
        await deps.finishCost(costLedger, "completed", aiQuotaConsumed({ kind: 'completed_answer' }));
        await send(done);
      },
    };
  }

  return { send: sendChatMessage, stream: streamChatMessage };
}
