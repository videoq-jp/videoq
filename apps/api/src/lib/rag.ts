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
import { chatSourceSchema, modelAnswerSchema, chatToolNameSchema, chatToolProgressEventSchema, type ChatToolProgressEvent, type ChatAnswer, type ChatSource, type ChatContentPart } from "@videoq/trpc/chat";
import { MAX_COURSE_INFO_CALLS, MAX_SCENE_SEARCHES } from "../tools/contract";
export { MAX_SCENE_SEARCHES } from "../tools/contract";
import { loadRagMcpTools } from "./rag-mcp-tools";
import { evidenceProgressSchema as searchProgressSchema } from "../tools/contract";
import { connectEvidenceMcp } from "../integrations/evidence-mcp";
import { MAX_WINDOW_READS, MAX_CLIP_INSPECTIONS, MAX_OVERVIEWS, MAX_SKIMS, MAX_FOCUS_CALLS } from "./video-evidence";
import {
  llmTimeoutMs,
  MAX_TOKENS,
  conversationMessages,
} from "./llm";
import { buildAgentSystemPrompt, buildNoCourseSystemPrompt } from "./prompts";
import type { SceneHit } from "../repositories/vector-repository";
import type { Bindings } from "../types/bindings";
import type { AnswerCostLedger } from "./answer-cost-ledger";

/**
 * QA モードの RAG 本体（ReAct）。
 * 最新 user 質問を抽出 → 講座メタ情報取得 / シーン検索 → 取得した根拠から回答する。
 * 検索は最大 MAX_SCENE_SEARCHES 回。メタ情報だけの回答では検索接続を開かない。
 * 会話・ツール結果はエージェントが保持し、根拠が足りない場合は追加取得する。
 */
type ChatMessageInput = { role: string; content: string };

export type RagResult = {
  queryText: string;
  answer: ChatAnswer;
  retrievedContexts: string[];
  /** Internal LangGraph state, never part of the public response. */
  checkpointId?: string;
  persistedTurn?: { chatLogId: number | null; feedback: string | null };
};

/**
 * 暴走時の保険。1 検索あたり model → tools の 2 ステップ進むので、
 * 上限まで検索しても足りる余白を持たせた値にする。
 */
export const MAX_TOOL_ROUNDS = MAX_SCENE_SEARCHES + MAX_COURSE_INFO_CALLS + MAX_WINDOW_READS + MAX_CLIP_INSPECTIONS + MAX_OVERVIEWS + MAX_SKIMS + MAX_FOCUS_CALLS;
// Each round includes summarization/validation hooks, the model and tools.
const RECURSION_LIMIT = 4 * MAX_TOOL_ROUNDS + 8;

/** 最新の user メッセージ本文を抽出する。 */
function extractLatestUserQuery(messages: readonly ChatMessageInput[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.content) return m.content;
  }
  if (messages.length > 0) return messages[messages.length - 1].content ?? "";
  return "";
}

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

const sceneKey = (hit: SceneHit) => `${hit.evidenceType ?? "transcript"}|${hit.videoId}|${hit.startTime}|${hit.endTime}`;

/** Assign stable source IDs across searches and persisted agent turns. */
class SceneCollector {
  constructor(private readonly allowed: readonly number[]) {}

  restore(sources: readonly ChatSource[]) {
    for (const source of sources) this.add({
      videoId: source.video_id, videoTitle: source.title, startTime: source.start_time ?? "",
      endTime: source.end_time ?? "", content: "", evidenceType: source.evidence_type,
    });
  }

  private readonly order: SceneHit[] = [];
  private readonly seen = new Map<string, number>();
  readonly courseContexts = new Set<string>();

  /** 既出なら既存の番号を、新規なら末尾に足して新しい番号を返す（1 始まり）。 */
  add(hit: SceneHit): number {
    const key = sceneKey(hit);
    const known = this.seen.get(key);
    if (known !== undefined) {
      // A new frame observation or a freshly edited subtitle window can carry
      // additional evidence at an existing timestamp. Preserve it in history.
      const prior = this.order[known - 1];
      prior.videoTitle = hit.videoTitle;
      if (!prior.content.includes(hit.content)) {
        prior.content += `\n${hit.content}`;
      }
      return known;
    }
    this.order.push(hit);
    const index = this.order.length;
    this.seen.set(key, index);
    return index;
  }

  get hits(): readonly SceneHit[] {
    return this.order.filter(hit => hit.content);
  }

  get sources(): ChatSource[] {
    return this.savedSources.filter(source => this.allowed.includes(source.video_id));
  }

  get savedSources(): ChatSource[] {
    return this.order.map((hit, index) => ({
      id: index + 1, video_id: hit.videoId, title: hit.videoTitle,
      start_time: hit.startTime, end_time: hit.endTime,
      ...(hit.evidenceType ? { evidence_type: hit.evidenceType } : {}),
    }));
  }
}

/** Use Core's event assembler; the graph's custom channel only forwards events. */
class ModelStreamHandler extends BaseCallbackHandler {
  name = "videoqModelStream";
  lc_prefer_chat_model_stream_events = true;
  awaitHandlers = true;

  constructor(private readonly writer: ((chunk: unknown) => void) | undefined) { super(); }

  handleChatModelStreamEvent(modelEvent: ChatModelStreamEvent) {
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
  let modelCalls = 0;
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
    const tools = connection ? await loadRagMcpTools(connection.client, params.signal, {
      addSource: hit => collector.add(hit), collectContext: text => collector.courseContexts.add(text),
    }) : [];
    const agent = createAgent({
      checkpointer: params.scope.memory?.saver ?? false,
      model: createChatModel(env, { maxTokens: MAX_TOKENS, timeoutMs: params.timeoutMs, costLedger: params.scope.costLedger }),
      responseFormat: providerStrategy(modelAnswerSchema),
      tools,
      middleware: [
        createMiddleware({
          name: "citationRegistry",
          stateSchema: new StateSchema({ evidenceSources: z.array(chatSourceSchema).default([]) }),
          beforeAgent(state) { collector.restore(state.evidenceSources); },
          afterAgent(state) {
            assertCompletedAnswer(state.messages.at(-1));
            completedResult = toResult(params.queryText, collector, state.structuredResponse);
            // Keep citation identities alongside native agent history, including
            // across summarization. Never reuse an old ID for a different scene.
            return { evidenceSources: collector.savedSources };
          },
        }),
        ...conversationCompaction(env, params.timeoutMs, params.scope.costLedger),
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
        wrapModelCall: (request, handler) => handler({
          ...request,
          // Summarization replaces graph messages; always restore trusted instructions.
          messages: [new SystemMessage(systemPrompt), ...request.messages.filter(message => message.type !== "system")],
          modelSettings: {
            ...request.modelSettings,
            ...(params.streaming ? { callbacks: [new ModelStreamHandler(request.runtime.writer)] } : {}),
          },
          tools: ++modelCalls > MAX_TOOL_ROUNDS ? [] : request.tools,
        }),
      }),
    ],
  });
  return {
    close: async () => { await connection?.close(); },
    agent,
    input: {
      messages: params.scope.memory?.checkpointId === null ? [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...inputMessages] : inputMessages,
      ...(params.scope.memory?.checkpointId === null ? { evidenceSources: [], structuredResponse: undefined } : {}),
    },
    result: () => {
      if (!completedResult) throw new Error("Missing completed agent answer");
      return completedResult;
    },
    generated: () => completedResult !== undefined,
    sources: () => collector.sources,
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
): RagResult {
  const hits = collector.hits;
  return {
    queryText,
    answer: validateChatAnswer(answer, collector.sources),
    retrievedContexts: [
      ...hits.map((hit) => hit.evidenceType === "visual"
        ? `Visual observation at ${hit.startTime}: ${hit.content}` : hit.content).filter((text) => text !== ""),
      ...collector.courseContexts,
    ],
  };
}

const hasAgentContext = (params: RagParams): boolean =>
  params.courseId != null || (params.videoIds !== null && params.videoIds.length > 0);

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
type RagToolProgress = z.infer<typeof toolProgressSchema>;

export type RagStreamChunk =
  | { part: ChatContentPart }
  | { source: ChatSource }
  | RagSearchProgress
  | RagToolProgress
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
    stopStream = () => events.return();

    // Core assembles each model turn from native events, including scalar
    // finish metadata. Forward those events through the graph writer so tool
    // progress, error delivery and cancellation keep the same graph lifecycle.
    // Only segments[].text is displayed; tool preambles are not answer text.
    let parser = new AnswerContentStream();
    let toolTurn = false;
    let emittedAnswer = false;
    let sentSources = 0;
    for await (const chunk of events) {
      if (!chunk || typeof chunk !== "object" || !("modelEvent" in chunk)) {
        const progress = searchProgressSchema.safeParse(chunk);
        if (progress.success) yield progress.data;
        else {
          const toolProgress = toolProgressSchema.safeParse(chunk);
          if (toolProgress.success) yield toolProgress.data;
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
    await stopStream?.();
    await prepared?.close();
  }
}
