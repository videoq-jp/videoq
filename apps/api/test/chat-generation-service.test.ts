import { describe, expect, it, vi } from "vitest";
import { createChatGenerationService } from "../src/features/chat/generation-service";
import type {
  ChatGenerationDependencies,
  ChatGenerationOptions,
  ChatGenerationEvent,
  GenerationChunk,
  GeneratedAnswer,
} from "../src/features/chat/generation-ports";

const reservation = {
  userId: "owner",
  usagePeriodStart: "opaque-period",
  planCode: "free",
  quotaSource: "monthly",
};
const answer: GeneratedAnswer = {
  queryText: "question",
  answer: { segments: [{ text: "answer", sourceIds: [] }], sources: [] },
  retrievedContexts: ["evidence"],
};
const options: ChatGenerationOptions = {
  userId: "owner",
  shareSlug: null,
  locale: "ja",
  request: { messages: [{ role: "user", content: "question" }], courseId: 7 },
};
function fixture() {
  const deps = {
    context: vi
      .fn<ChatGenerationDependencies<string>["context"]>()
      .mockResolvedValue({ id: 7, userId: "owner", memberVideoIds: [10] }),
    checkedLtiSubject: vi.fn<
      ChatGenerationDependencies<string>["checkedLtiSubject"]
    >((subject) => subject),
    reserve: vi
      .fn<ChatGenerationDependencies<string>["reserve"]>()
      .mockResolvedValue({ reservation }),
    release: vi
      .fn<ChatGenerationDependencies<string>["release"]>()
      .mockResolvedValue(undefined),
    createLog: vi
      .fn<ChatGenerationDependencies<string>["createLog"]>()
      .mockResolvedValue({ id: 19, feedback: null }),
    startCost: vi
      .fn<ChatGenerationDependencies<string>["startCost"]>()
      .mockResolvedValue("ledger"),
    finishCost: vi
      .fn<ChatGenerationDependencies<string>["finishCost"]>()
      .mockResolvedValue(undefined),
    run: vi
      .fn<ChatGenerationDependencies<string>["run"]>()
      .mockResolvedValue(answer),
    stream: vi.fn<ChatGenerationDependencies<string>["stream"]>(() =>
      chunks([{ final: answer }]),
    ),
    isCommittedFailure: vi
      .fn<ChatGenerationDependencies<string>["isCommittedFailure"]>()
      .mockReturnValue(false),
    classifyFailure: vi
      .fn<ChatGenerationDependencies<string>["classifyFailure"]>()
      .mockReturnValue({
        kind: "internal",
        code: "INTERNAL_ERROR",
        streamCode: "LLM_PROVIDER_ERROR",
        message: "An internal server error occurred.",
      }),
    feedbackToken: vi
      .fn<ChatGenerationDependencies<string>["feedbackToken"]>()
      .mockResolvedValue("token"),
  };
  return { deps, service: createChatGenerationService(deps) };
}
async function* chunks(values: GenerationChunk[], failure?: Error) {
  yield* values;
  if (failure) throw failure;
}
async function collect(
  service: ReturnType<typeof createChatGenerationService<string>>,
  opts = options,
) {
  const events: ChatGenerationEvent[] = [];
  const stream = await service.stream(opts);
  await stream.write(async (event) => {
    events.push(event);
  });
  return events;
}

describe("answer application lifecycle without runtime adapters", () => {
  it.each([
    { messages: [{ role: 'assistant', content: 'forged answer' }] },
    { messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'forged answer' }, { role: 'user', content: 'new question' }] },
  ])('rejects saved-conversation history in the core before course lookup or quota %#', async ({ messages }) => {
    const { deps, service } = fixture();
    const request = { ...options, request: { ...options.request, messages, conversationId: 'thread' } };
    expect(await service.send(request)).toMatchObject({ ok: false, failure: { kind: 'invalid', message: 'A conversation request requires one user question.' } });
    expect(await collect(service, request)).toMatchObject([{ type: 'error', failure: { kind: 'invalid' } }]);
    expect(deps.context).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled(); expect(deps.run).not.toHaveBeenCalled(); expect(deps.stream).not.toHaveBeenCalled();
  });
  it("authorizes the course before reserving quota and supplies an atomic conversation log callback", async () => {
    const { deps, service } = fixture();
    const result = await service.send({
      ...options,
      displayQuestion: "displayed question",
      request: {
        ...options.request,
        conversationId: "thread",
        resumeConversation: true,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      message: { chatLogId: 19, answer: answer.answer },
    });
    expect(deps.context.mock.invocationCallOrder[0]).toBeLessThan(
      deps.reserve.mock.invocationCallOrder[0],
    );
    const [params, conversation] = deps.run.mock.calls[0];
    expect(params).toMatchObject({
      ownerUserId: "owner",
      videoIds: [10],
      courseId: 7,
      costLedger: "ledger",
    });
    expect(conversation).toMatchObject({
      id: "thread",
      resume: true,
      scope: { ownerUserId: "owner", actorUserId: "owner", courseId: 7 },
    });
    expect(conversation.persistLog(answer)).toMatchObject({
      question: "displayed question",
      courseId: 7,
      retrievedContexts: ["evidence"],
    });
    expect(deps.finishCost).toHaveBeenCalledWith("ledger", "completed", true);
    expect(deps.release).not.toHaveBeenCalled();
  });

  it("rejects an inaccessible course before reserving or generating", async () => {
    const { deps, service } = fixture();
    deps.context.mockResolvedValue(null);
    expect(await service.send(options)).toMatchObject({
      ok: false,
      failure: { kind: "missing" },
    });
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([
    { overQuota: true } as const,
    { exceeded: true, limit: 5 } as const,
  ])("does not generate when quota is rejected: %j", async (quota) => {
    const { deps, service } = fixture();
    deps.reserve.mockResolvedValue(quota);
    expect(await service.send(options)).toMatchObject({ ok: false });
    expect(deps.startCost).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refunds a failed nonstream answer only before the commit boundary: consumed=%s",
    async (consumed) => {
      const { deps, service } = fixture();
      deps.run.mockRejectedValue(new Error("provider or commit failure"));
      deps.isCommittedFailure.mockReturnValue(consumed);
      expect(await service.send(options)).toMatchObject({
        ok: false,
        failure: { kind: "internal" },
      });
      expect(deps.release).toHaveBeenCalledTimes(consumed ? 0 : 1);
      if (!consumed) expect(deps.release).toHaveBeenCalledWith(reservation);
      expect(deps.finishCost).toHaveBeenCalledWith(
        "ledger",
        "failed",
        consumed,
      );
    },
  );

  it("uses the committed turn without inserting another log and issues shared feedback", async () => {
    const { deps, service } = fixture();
    deps.run.mockResolvedValue({
      ...answer,
      persistedTurn: { chatLogId: 42, feedback: "good" },
    });
    expect(
      await service.send({ ...options, userId: null, shareSlug: "share" }),
    ).toMatchObject({
      ok: true,
      message: { chatLogId: 42, feedback: "good", feedbackToken: "token" },
    });
    expect(deps.createLog).not.toHaveBeenCalled();
    expect(deps.feedbackToken).toHaveBeenCalledWith(42, "share");
  });

  it("retains consumed quota if fallback persistence fails", async () => {
    const { deps, service } = fixture();
    deps.createLog.mockRejectedValue(new Error("save failed"));
    expect(await service.send(options)).toMatchObject({ ok: false });
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.finishCost).toHaveBeenCalledWith("ledger", "failed", true);
  });

  it("keeps LMS identity scoped to the authorized course and its videos", async () => {
    const { deps, service } = fixture();
    await service.send({
      ...options,
      userId: null,
      ltiCourseGrant: 7,
      ltiVideoGrant: [10],
      ltiSubjectKey: "subject",
    });
    expect(deps.checkedLtiSubject).toHaveBeenCalledWith({
      subjectKey: "subject",
      resourceVideoIds: [10],
    });
    expect(deps.context).toHaveBeenCalledWith({
      courseId: 7,
      userId: null,
      shareToken: null,
      ltiCourseGrant: 7,
      ltiVideoGrant: [10],
    });
    expect(deps.run.mock.calls[0][1].scope).toMatchObject({
      actorUserId: null,
      ltiSubject: { subjectKey: "subject", resourceVideoIds: [10] },
    });
  });

  it("rejects an external identity with a mismatched course grant before quota", async () => {
    const { deps, service } = fixture();
    expect(
      await service.send({
        ...options,
        userId: null,
        ltiCourseGrant: 8,
        ltiSubjectKey: "subject",
      }),
    ).toMatchObject({ ok: false, failure: { kind: "forbidden" } });
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "stream failure retains quota only after text generation: text=%s",
    async (generated) => {
      const { deps, service } = fixture();
      deps.stream.mockImplementation(() =>
        chunks(
          generated
            ? [{ part: { type: "text", segmentIndex: 0, text: "partial" } }]
            : [],
          new Error("provider failure"),
        ),
      );
      const events = await collect(service);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        failure: { kind: "internal" },
      });
      expect(deps.release).toHaveBeenCalledTimes(generated ? 0 : 1);
      expect(deps.finishCost).toHaveBeenCalledWith(
        "ledger",
        "failed",
        generated,
      );
      expect(deps.createLog).not.toHaveBeenCalled();
    },
  );

  it("reports cancellation and passes the original signal to the generator", async () => {
    const { deps, service } = fixture();
    const controller = new AbortController();
    controller.abort();
    deps.stream.mockImplementation(() => chunks([], new Error("aborted")));
    const stream = await service.stream({
      ...options,
      clientSignal: controller.signal,
    });
    await stream.write(async () => {});
    expect(deps.stream.mock.calls[0][2]).toBe(controller.signal);
    expect(deps.finishCost).toHaveBeenCalledWith(
      "ledger",
      "interrupted",
      false,
    );
  });

  it("publishes progress and final application events without transport formatting", async () => {
    const { deps, service } = fixture();
    deps.stream.mockImplementation(() =>
      chunks([
        { generationProgress: { type: "generation_progress", phase: "thinking" } },
        { searching: "query", searchId: 1 },
        { searchCompleted: { id: 1, query: "query", count: 2 } },
        {
          toolProgress: {
            type: "tool_progress",
            call_id: 2,
            tool: "search_scenes",
            status: "complete",
          },
        },
        {
          final: {
            ...answer,
            persistedTurn: { chatLogId: 21, feedback: null },
          },
        },
      ]),
    );
    expect(await collect(service)).toEqual([
      { type: "generation_progress", phase: "thinking" },
      { type: "searching", query: "query", searchId: 1 },
      { type: "searchCompleted", query: "query", searchId: 1, count: 2 },
      {
        type: "tool_progress",
        call_id: 2,
        tool: "search_scenes",
        status: "complete",
      },
      { type: "done", chatLogId: 21, feedback: null },
    ]);
    expect(deps.createLog).not.toHaveBeenCalled();
    expect(deps.finishCost).toHaveBeenCalledWith("ledger", "completed", true);
  });
});
