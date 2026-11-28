import { createAgent, createMiddleware, providerStrategy } from "langchain";
import { SystemMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { z } from "zod";
import { createChatModel, toLlmError } from "./chat-model";
import { deadlineSignal } from "./request-timeout";
import { assertCompletedAnswer } from "./structured-answer";
import { conversationCompaction } from "./conversation-compaction";
import { REMOVE_ALL_MESSAGES, StateSchema } from "@langchain/langgraph";
import { conversationConfig, requireConversationCheckpoint, ConversationCommitError, type ConversationMemory } from "./conversation";
import { AnswerContentStream } from "./answer-content-stream";
import { LlmProviderError } from "./openai";
import { validateChatAnswer } from "./chat-citations";
import { chatSourceSchema, modelAnswerSchema, chatToolNameSchema, chatToolProgressEventSchema, chatGenerationProgressEventSchema, type ChatGenerationProgressEvent, type ChatToolProgressEvent, type ChatSource, type ChatContentPart } from "@videoq/trpc/chat";
import { MAX_COURSE_INFO_CALLS, MAX_SCENE_SEARCHES } from '../domain/conversation/evidence';
import { MAX_TOOL_ROUNDS, AnswerAgentBudget, hasAgentContext } from '../domain/conversation/agent-execution';
export { MAX_TOOL_ROUNDS } from '../domain/conversation/agent-execution';
export { MAX_SCENE_SEARCHES } from "../tools/contract";
import { retrieveInitialScenes } from "./initial-scene-search";
import { loadRagMcpTools } from "./rag-mcp-tools";
import { evidenceProgressSchema as searchProgressSchema } from "../tools/contract";
import { connectEvidenceMcp } from "../integrations/evidence-mcp";
import {
  llmTimeoutMs,
  MAX_TOKENS,
  conversationMessages,
} from "./llm";
import { buildAgentSystemPrompt, buildNoCourseSystemPrompt } from "./prompts";
import { SceneCollector, extractLatestUserQuery } from '../features/chat/evidence-registry';
import type { Bindings } from "../types/bindings";
import type { AnswerCostLedger } from "./answer-cost-ledger";

/**
 * QA モードの RAG 本体（ReAct）。
 * 最新 user 質問を抽出 → 講座メタ情報取得 / シーン検索 → 取得した根拠から回答する。
 * 検索は最大 MAX_SCENE_SEARCHES 回。メタ情報の質問も含め、回答生成前に最低1回検索する。
 * 会話・ツール結果はエージェントが保持し、根拠が足りない場合は追加取得する。
 */
type ChatMessageInput = { role: string; content: string };

export type { GenerationResult as RagResult } from '../domain/conversation/answer-generation';
import type { GenerationResult as RagResult } from '../domain/conversation/answer-generation';

/**
 * 暴走時の保険。1 検索あたり model → tools の 2 ステップ進むので、
 * 上限まで検索しても足りる余白を持たせた値にする。
 */
// Each round includes summarization/validation hooks, the model and tools.
const RECURSION_LIMIT = 4 * MAX_TOOL_ROUNDS + 8;

export type RagParams = {
  messages: readonly ChatMessageInput[];
  memory?: ConversationMemory;
  ownerUserId: string;
  videoIds: readonly number[] | null;
  locale: string | null;
  /** setupChat でアクセス確認済みの講座ID。クライアントやモデルから直接渡さない。 */
  courseId?: number | null;
  costLedger?: AnswerCostLedger;
};

/** Use Core's event assembler; the graph's custom channel only forwards events. */
class ModelStreamHandler extends BaseCallbackHandler {
  name = "videoqModelStream";
  lc_prefer_chat_model_stream_events = true;
  awaitHandlers = true;

  constructor(private readonly writer: ((chunk: unknown) => void) | undefined) { super(); }

  handleChatModelStreamEvent(modelEvent: ChatModelStreamEvent, _runId: string, _parentRunId?: string, tags?: string[]) {
    if (tags?.includes("videoq:conversation-summary")) return;
    this.writer?.({ modelEvent });
  }
}

/** 検索スコープを固定した ReAct エージェントを組み立てる。 */
async function prepareAgent(
  env: Bindings,
  params: {
    queryText: string;
    timeoutMs: number;
    scope: RagParams;
    signal: AbortSignal;
    streaming?: boolean;
  },
) {
  const collector = new SceneCollector(params.scope.videoIds ?? []);
  const systemPrompt = hasAgentContext(params.scope)
    ? buildAgentSystemPrompt(params.scope.locale, MAX_SCENE_SEARCHES, MAX_COURSE_INFO_CALLS)
    : buildNoCourseSystemPrompt(params.scope.locale);
  const inputMessages = params.scope.memory
    ? [new HumanMessage(params.queryText)] : conversationMessages(params.scope.messages);
  let completedResult: RagResult | undefined;
  let writeProgress: ((chunk: unknown) => void) | undefined;
  const modelBudget = new AnswerAgentBudget();
  let toolCalls = 0;
  // system は createAgent の systemPrompt ではなく messages で渡す。
  // systemPrompt はコンテンツブロック配列（[{type:"text"}]）で送信されるため、
  // 素の文字列しか受け付けない OpenAI 互換ゲートウェイでも動くようにする。
  const connection = hasAgentContext(params.scope) ? await connectEvidenceMcp(env, {
    ownerUserId: params.scope.ownerUserId, videoIds: params.scope.videoIds ?? [], courseId: params.scope.courseId,
  }, params.signal, {
    question: params.queryText, usage: params.scope.costLedger,
  }) : undefined;
  try {
    let selectedVideoIds: number[] | null = null;
    const answerSources = () => collector.sources.filter(source => selectedVideoIds === null || selectedVideoIds.includes(source.video_id));
    const evidenceOptions = {
      addSource: (hit: Parameters<SceneCollector["add"]>[0]) => collector.add(hit),
      collectContext: (text: string) => collector.courseContexts.add(text),
      selectedVideoIds: () => selectedVideoIds,
    };
    const tools = connection ? await loadRagMcpTools(connection.client, params.signal, evidenceOptions) : [];
    const agent = createAgent({
      checkpointer: params.scope.memory?.saver ?? false,
      model: createChatModel(env, { maxTokens: MAX_TOKENS, timeoutMs: params.timeoutMs, costLedger: params.scope.costLedger }),
      responseFormat: providerStrategy(modelAnswerSchema),
      tools,
      middleware: [
        createMiddleware({
          name: "citationRegistry",
          stateSchema: new StateSchema({ evidenceSources: z.array(chatSourceSchema).default([]),
            confirmedSearchScope: z.object({ videoIds: z.array(z.number().int().positive().safe()).min(1).max(50).nullable() }).nullable().optional(),
          }),
          async beforeAgent(state, runtime) {
            collector.restore(state.evidenceSources);
            // Capture the request's custom stream writer for summary callbacks;
            // callback execution does not inherit the graph's async-local config.
            if (params.streaming) writeProgress = runtime.writer;
            if (!connection) return;
            const messages = await retrieveInitialScenes({
              env, timeoutMs: params.timeoutMs, costLedger: params.scope.costLedger,
              signal: params.signal, messages: state.messages, sources: collector.sources, confirmedScope: state.confirmedSearchScope ?? undefined,
              allowedVideoIds: params.scope.videoIds ?? [], tools, locale: params.scope.locale,
              client: connection.client, evidenceOptions, writer: runtime.writer,
              selectVideos: ids => { selectedVideoIds = ids; },
              nextCallId: () => ++toolCalls,
            });
            return { messages, evidenceSources: collector.savedSources, confirmedSearchScope: { videoIds: selectedVideoIds } };
          },
          afterAgent(state) {
            assertCompletedAnswer(state.messages.at(-1));
            completedResult = toResult(params.queryText, collector, state.structuredResponse, answerSources());
            // Keep citation identities alongside native agent history, including
            // across summarization. Never reuse an old ID for a different scene.
            return { evidenceSources: collector.savedSources };
          },
        }),
        ...conversationCompaction(env, params.timeoutMs, params.scope.costLedger, () => writeProgress?.({
          generationProgress: { type: "generation_progress", phase: "summarizing" },
        } satisfies RagGenerationProgress)),
        createMiddleware({
          name: "propagateSearchErrors",
          // wrapToolCall 経由の実行例外は、そのまま呼び出し元へ伝播する。
          // DB / 埋め込み障害で次の LLM 呼び出しを始めず、利用枠を返却する。
          // ツール引数の検証エラーは LangChain が従来どおりモデルへ返す。
          wrapToolCall: async (request, handler) => {
            const name = chatToolNameSchema.safeParse(request.toolCall.name);
            if (!name.success) return handler(request);
            // Request-local IDs also distinguish repeated and concurrent calls.
            // Only public tool names/statuses are streamed, never arguments or results.
            const callId = ++toolCalls;
            const emit = (status: ChatToolProgressEvent["status"]) => request.runtime.writer?.({
              toolProgress: { type: "tool_progress", call_id: callId, tool: name.data, status },
            } satisfies RagToolProgress);
            emit("running");
            try {
              const result = await handler(request);
              emit("status" in result && result.status === "error" ? "error" : "complete");
              return result;
          } catch (error) {
            emit("error");
            throw error;
          }
        },
        // 引数不備の繰り返しも含め、最終ターンはツールなしで回答させる。
        wrapModelCall: (request, handler) => {
          const tools = modelBudget.allowToolsForNextModelCall() ? request.tools : [];
          if (params.streaming) request.runtime.writer?.({
            generationProgress: {
              type: "generation_progress",
              phase: tools.length === 0 ? "answering" : toolCalls > 0 ? "reviewing" : "thinking",
            },
          } satisfies RagGenerationProgress);
          return handler({
            ...request,
            // Prepend trusted application instructions to the current conversation context.
            messages: [new SystemMessage(systemPrompt + (selectedVideoIds ? `\nFor this answer, use evidence only from selected video IDs: ${selectedVideoIds.join(", ")}. Earlier evidence from other videos is outside this question's scope.` : "")), ...request.messages],
            modelSettings: {
              ...request.modelSettings,
              ...(params.streaming ? { callbacks: [new ModelStreamHandler(request.runtime.writer)] } : {}),
            },
            tools,
          });
        },
      }),
    ],
  });
  return {
    close: async () => { await connection?.close(); },
    agent,
    input: {
      messages: params.scope.memory?.checkpointId === null ? [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...inputMessages] : inputMessages,
      ...(params.scope.memory?.checkpointId === null ? { evidenceSources: [], confirmedSearchScope: null, structuredResponse: undefined } : {}),
    },
    result: () => {
      if (!completedResult) throw new Error("Missing completed agent answer");
      return completedResult;
    },
    generated: () => completedResult !== undefined,
    sources: answerSources,
  };
  } catch (error) {
    await connection?.close();
    throw error;
  }
}

function toResult(
  queryText: string,
  collector: SceneCollector,
  answer: unknown,
  sources: readonly ChatSource[] = collector.sources,
): RagResult {
  const hits = collector.hits.filter(hit => sources.some(source => source.video_id === hit.videoId));
  return {
    queryText,
    answer: validateChatAnswer(answer, sources),
    retrievedContexts: [
      ...hits.map((hit) => hit.evidenceType === "visual"
        ? `Visual observation at ${hit.startTime}: ${hit.content}` : hit.content).filter((text) => text !== ""),
      ...collector.courseContexts,
    ],
  };
}

export async function runRag(
  env: Bindings,
  params: RagParams,
): Promise<RagResult> {
  await requireConversationCheckpoint(params.memory);
  const queryText = extractLatestUserQuery(params.messages);

  const lifecycle = new AbortController();
  const requestSignal = deadlineSignal(llmTimeoutMs(env), lifecycle.signal);
  let prepared: Awaited<ReturnType<typeof prepareAgent>> | undefined;
  try {
    prepared = await prepareAgent(env, {
      queryText,
      timeoutMs: llmTimeoutMs(env),
      scope: params,
      signal: requestSignal,
    });
    await prepared.agent.invoke(prepared.input, {
      ...conversationConfig(params.memory), recursionLimit: RECURSION_LIMIT,
      signal: requestSignal,
    });
    const final = prepared.result();
    const checkpoint = params.memory ? await params.memory.saver.getTuple({ configurable: { thread_id: params.memory.threadId } }) : undefined;
    return { ...final, checkpointId: checkpoint?.config.configurable?.checkpoint_id as string | undefined };
  } catch (error) {
    if (params.memory && prepared?.generated()) throw new ConversationCommitError(error);
    throw toLlmError(error);
  } finally {
    // 並列ツールの一方が失敗しても、残りの検索をバックグラウンドに残さない。
    lifecycle.abort();
    await prepared?.close();
  }
}

type RagSearchProgress = z.infer<typeof searchProgressSchema>;
const toolProgressSchema = z.object({ toolProgress: chatToolProgressEventSchema });
const generationProgressSchema = z.object({ generationProgress: chatGenerationProgressEventSchema });
type RagGenerationProgress = { generationProgress: ChatGenerationProgressEvent };
type RagToolProgress = z.infer<typeof toolProgressSchema>;

export type RagStreamChunk =
  | { part: ChatContentPart }
  | { source: ChatSource }
  | RagSearchProgress
  | RagToolProgress
  | RagGenerationProgress
  | { final: RagResult };

/** `signal` はクライアント切断時に上流 LLM も止めるためのもの（コスト保護）。 */
export async function* streamRag(
  env: Bindings,
  params: RagParams,
  signal?: AbortSignal,
): AsyncGenerator<RagStreamChunk> {
  await requireConversationCheckpoint(params.memory);
  const queryText = extractLatestUserQuery(params.messages);

  const lifecycle = new AbortController();
  const requestSignal = AbortSignal.any([
    deadlineSignal(llmTimeoutMs(env, true), signal),
    lifecycle.signal,
  ]);
  let prepared: Awaited<ReturnType<typeof prepareAgent>> | undefined;
  let stopStream: (() => Promise<unknown>) | undefined;
  try {
    prepared = await prepareAgent(env, { queryText, timeoutMs: llmTimeoutMs(env, true), scope: params,
      signal: requestSignal, streaming: true,
    });
    const events = await prepared.agent.stream(prepared.input, {
      ...conversationConfig(params.memory), signal: requestSignal,
      recursionLimit: RECURSION_LIMIT, streamMode: "custom",
    });
    stopStream = async () => {
      try {
        await events.return();
      } catch (error) {
        // LangGraph reports its own cancellation while closing an interrupted
        // stream. Errors from next() still pass through the main catch below.
        if (!(error instanceof Error && error.message === "Abort")) throw error;
      }
    };

    // Core assembles each model turn from native events, including scalar
    // finish metadata. Forward those events through the graph writer so tool
    // progress, error delivery and cancellation keep the same graph lifecycle.
    // Only segments[].text is displayed; tool preambles are not answer text.
    let parser = new AnswerContentStream();
    let toolTurn = false;
    let emittedAnswer = false;
    let sentSources = 0;
    // Abort our request before closing the graph iterator in finally. Recent
    // LangGraph versions cancel active tools when return() is called; implicit
    // for-await cleanup otherwise surfaces that expected cancellation as an error.
    while (true) {
      const next: IteratorResult<unknown> = await events.next();
      if (next.done) break;
      const chunk = next.value;
      if (!chunk || typeof chunk !== "object" || !("modelEvent" in chunk)) {
        const progress = searchProgressSchema.safeParse(chunk);
        if (progress.success) yield progress.data;
        else {
          const toolProgress = toolProgressSchema.safeParse(chunk);
          if (toolProgress.success) yield toolProgress.data;
          else {
            const generationProgress = generationProgressSchema.safeParse(chunk);
            if (generationProgress.success) yield generationProgress.data;
          }
        }
      } else {
        const message = chunk.modelEvent as ChatModelStreamEvent;
        if (message.event === "message-start") {
          if (emittedAnswer) throw new LlmProviderError("Model continued after streaming an answer.");
          parser = new AnswerContentStream();
          toolTurn = false;
        }
        if (message.event === "content-block-start" && message.content.type === "tool_call_chunk") {
          if (emittedAnswer) throw new LlmProviderError("Model called a tool after streaming an answer.");
          toolTurn = true;
        }
        if (toolTurn || message.event !== "content-block-delta" || message.delta.type !== "text-delta") continue;
        const sources = prepared.sources();
        for (const source of sources.slice(sentSources)) yield { source };
        sentSources = sources.length;
        for (const part of parser.push(message.delta.text, sources)) {
          emittedAnswer = true;
          yield { part };
        }
      }
    }
    requestSignal.throwIfAborted();

    const final = prepared.result();
    const { answer } = final;
    for (const source of answer.sources.slice(sentSources)) yield { source };
    for (const part of parser.finish(answer)) yield { part };
    const checkpoint = params.memory ? await params.memory.saver.getTuple({ configurable: { thread_id: params.memory.threadId } }) : undefined;
    yield { final: { ...final, checkpointId: checkpoint?.config.configurable?.checkpoint_id as string | undefined } };
  } catch (error) {
    throw toLlmError(error);
  } finally {
    // 送信失敗などで consumer が途中終了した場合も、検索の通信を止める。
    lifecycle.abort();
    try {
      await stopStream?.();
    } finally {
      await prepared?.close();
    }
  }
}
