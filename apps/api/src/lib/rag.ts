import { createAgent, createMiddleware, providerStrategy, tool, type ToolRuntime } from "langchain";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { z } from "zod";
import { createChatModel, toLlmError } from "./chat-model";
import { deadlineSignal } from "./request-timeout";
import { assertCompletedAnswer } from "./structured-answer";
import { AnswerContentStream } from "./answer-content-stream";
import { LlmProviderError } from "./openai";
import { validateChatAnswer } from "./chat-citations";
import { modelAnswerSchema, chatToolNameSchema, chatToolProgressEventSchema, type ChatToolProgressEvent, type ChatAnswer, type ChatSource, type ChatContentPart } from "@videoq/trpc/chat";
import { courseInfoTool, MAX_COURSE_INFO_CALLS } from "./rag-course-info";
import { videoEvidenceTools } from "./rag-video-evidence";
import { transcriptQuality } from "./transcript-quality";
import { MAX_WINDOW_READS, MAX_CLIP_INSPECTIONS, MAX_OVERVIEWS, MAX_SKIMS, MAX_FOCUS_CALLS } from "./video-evidence";
import {
  llmTimeoutMs,
  MAX_TOKENS,
  generateReply,
  streamReply,
} from "./llm";
import { buildAgentSystemPrompt, buildNoCourseSystemPrompt } from "./prompts";
import { openSceneSearch, type SceneHit, type SceneSearch } from "../repositories/vector-repository";
import type { Bindings } from "../types/bindings";
import type { AnswerCostLedger } from "./answer-cost-ledger";

/**
 * QA モードの RAG 本体（ReAct）。
 * 最新 user 質問を抽出 → 講座メタ情報取得 / シーン検索 → 取得した根拠から回答する。
 * 検索は最大 MAX_SCENE_SEARCHES 回。メタ情報だけの回答では検索接続を開かない。
 * 会話履歴は渡さない（system + human の 2 通のみ）。
 */
type ChatMessageInput = { role: string; content: string };

export type RagResult = {
  queryText: string;
  answer: ChatAnswer;
  retrievedContexts: string[];
};

/** 1 回答あたりのベクトル検索回数の上限。検索ごとに埋め込みを生成する。 */
export const MAX_SCENE_SEARCHES = 3;

/** ヒット 0 件でも「検索したが無かった」と伝える。空文字だとモデルが再検索を繰り返す。 */
const NO_HITS = "No subtitle scenes matched this query. Subtitle search does not inspect images and cannot establish that visible content is absent. Use video viewing tools for on-screen text, objects or changes.";

/** 上限超過はツール結果として返す。エラーで打ち切ると回答本文が無いまま終わるため。 */
const SEARCH_LIMIT_REACHED =
  "Search limit reached: no more searches are available for this answer. " +
  "Answer now using the scenes you already have, or state that the question is " +
  "outside the scope of the video materials.";

/**
 * 暴走時の保険。1 検索あたり model → tools の 2 ステップ進むので、
 * 上限まで検索しても足りる余白を持たせた値にする。
 */
export const MAX_TOOL_ROUNDS = MAX_SCENE_SEARCHES + MAX_COURSE_INFO_CALLS + MAX_WINDOW_READS + MAX_CLIP_INSPECTIONS + MAX_OVERVIEWS + MAX_SKIMS + MAX_FOCUS_CALLS;
const RECURSION_LIMIT = 2 * MAX_TOOL_ROUNDS + 4;

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
  ownerUserId: string;
  videoIds: readonly number[] | null;
  locale: string | null;
  /** setupChat でアクセス確認済みの講座ID。クライアントやモデルから直接渡さない。 */
  courseId?: number | null;
  costLedger?: AnswerCostLedger;
};

const sceneKey = (hit: SceneHit) => `${hit.evidenceType ?? "transcript"}|${hit.videoId}|${hit.startTime}|${hit.endTime}`;

/** Assign stable source IDs across all searches in one answer. */
class SceneCollector {
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
    return this.order;
  }

  get sources(): ChatSource[] {
    return this.order.map((hit, index) => ({
      id: index + 1, video_id: hit.videoId, title: hit.videoTitle,
      start_time: hit.startTime, end_time: hit.endTime,
      ...(hit.evidenceType ? { evidence_type: hit.evidenceType } : {}),
    }));
  }
}

const formatHit = (hit: SceneHit, index: number) =>
  JSON.stringify({ sourceId: index, videoId: hit.videoId, title: hit.videoTitle, startTime: hit.startTime, endTime: hit.endTime, text: hit.content, transcript_quality: transcriptQuality(hit) });

function sceneSearchTool(
  search: SceneSearch,
  collector: SceneCollector,
  videoIds: readonly number[],
) {
  let used = 0;
  const allowedVideoIds = new Set(videoIds);
  return tool(
    async ({ query, video_ids }, runtime: ToolRuntime) => {
      // 上限はツール側で数える。middleware で打ち切るとモデルが最終回答を
      // 生成する前にグラフが終わってしまう。
      if (used >= MAX_SCENE_SEARCHES) return SEARCH_LIMIT_REACHED;
      if (video_ids?.some((id) => !allowedVideoIds.has(id))) {
        return "Invalid video_ids: only videos in the current course may be searched. " +
          "Use get_course_info to find valid IDs; this search was not executed.";
      }
      const searchId = ++used;
      // custom stream は検索の完了や次のモデルの応答を待たずに UI へ届く。
      runtime.writer?.({ searching: query, searchId } satisfies RagSearchProgress);
      const hits = await search.search(query, video_ids ?? undefined);
      runtime.writer?.({
        searchCompleted: { id: searchId, query, count: hits.length },
      } satisfies RagSearchProgress);
      if (hits.length === 0) return NO_HITS;
      return hits.map((hit) => formatHit(hit, collector.add(hit))).join("\n\n");
    },
    {
      name: "search_scenes",
      description:
        "Search spoken subtitles of the user's video course by meaning, not images, and return the closest excerpts. " +
        "The default way to ground definitions, explanations, comparisons, examples and calculations, " +
        "including short terms and questions that do not explicitly mention the course. " +
        "For highlights, first identify the video's genre; visual highlights need viewing tools and candidate before/after evidence, not only matching subtitles. " +
        "For broad video navigation or visual topics without subtitle clues, overview_video/skim_video can retrieve evidence instead. " +
        "For course-wide content, call directly with video_ids set to null. For a specific video or lecture, " +
        "first identify it with get_course_info and include its ID in video_ids on every search. " +
        "Pass a natural-language query describing what you need; it does not have to be the " +
        "user's question verbatim. Optionally select video_ids from get_course_info; using " +
        "null searches the whole current course. Each scene has a sourceId for the answer segments.",
      schema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe("What to look for, in the same language as the course material."),
        video_ids: z.array(z.number().int().positive().safe()).min(1).max(50).nullable()
          .describe("IDs of videos in the current course to search; null for the whole course."),
      }).strict(),
    },
  );
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
function prepareAgent(
  env: Bindings,
  params: {
    search: SceneSearch;
    queryText: string;
    timeoutMs: number;
    scope: RagParams;
    signal: AbortSignal;
    streaming?: boolean;
  },
) {
  const collector = new SceneCollector();
  const systemPrompt = buildAgentSystemPrompt(
    params.scope.locale,
    MAX_SCENE_SEARCHES,
    MAX_COURSE_INFO_CALLS,
  );
  let modelCalls = 0;
  let toolCalls = 0;
  // system は createAgent の systemPrompt ではなく messages で渡す。
  // systemPrompt はコンテンツブロック配列（[{type:"text"}]）で送信されるため、
  // 素の文字列しか受け付けない OpenAI 互換ゲートウェイでも動くようにする。
  const agent = createAgent({
    model: createChatModel(env, { maxTokens: MAX_TOKENS, timeoutMs: params.timeoutMs, costLedger: params.scope.costLedger }),
    responseFormat: providerStrategy(modelAnswerSchema),
    tools: [
      sceneSearchTool(params.search, collector, params.scope.videoIds ?? []),
      ...videoEvidenceTools(env, {
        ownerUserId: params.scope.ownerUserId, videoIds: params.scope.videoIds ?? [],
      }, hit => collector.add(hit), params.signal, params.queryText, params.scope.costLedger),
      ...(params.scope.courseId != null ? [courseInfoTool(env, {
        courseId: params.scope.courseId,
        ownerUserId: params.scope.ownerUserId,
      }, (context) => collector.courseContexts.add(context))] : []),
    ],
    middleware: [
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
    agent,
    input: { messages: [new SystemMessage(systemPrompt), new HumanMessage(params.queryText)] },
    result: (answer: unknown) => toResult(params.queryText, collector, answer),
    sources: () => collector.sources,
  };
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

/** 同時ツール呼び出しでも接続は1つ。検索を呼ぶまでDB・埋め込みに依存しない。 */
function lazySceneSearch(env: Bindings, params: RagParams, signal: AbortSignal): SceneSearch {
  let pending: Promise<SceneSearch> | undefined;
  return {
    async search(query, videoIds) {
      signal.throwIfAborted();
      if (!params.videoIds?.length) return [];
      pending ??= openSceneSearch(env, {
        userId: params.ownerUserId,
        videoIds: params.videoIds,
      }, signal, params.costLedger);
      return (await pending).search(query, videoIds);
    },
    async close() {
      // 初期化失敗時の close は openSceneSearch が行う。元の例外を上書きしない。
      const search = await pending?.catch(() => undefined);
      try {
        await search?.close();
      } catch (error) {
        // 後始末の障害で元の例外や送信済みの回答を上書きしない。
        console.error(JSON.stringify({
          event: "rag_search_close_failed",
          errorType: error instanceof Error ? error.name : "unknown",
        }));
      }
    },
  };
}

export async function runRag(
  env: Bindings,
  params: RagParams,
): Promise<RagResult> {
  const queryText = extractLatestUserQuery(params.messages);

  if (!hasAgentContext(params)) {
    const systemPrompt = buildNoCourseSystemPrompt(params.locale);
    return { queryText, retrievedContexts: [], answer: validateChatAnswer(await generateReply(env, systemPrompt, queryText, params.costLedger), []) };
  }

  const lifecycle = new AbortController();
  const requestSignal = deadlineSignal(llmTimeoutMs(env), lifecycle.signal);
  const search = lazySceneSearch(env, params, requestSignal);
  try {
    const prepared = prepareAgent(env, {
      search,
      queryText,
      timeoutMs: llmTimeoutMs(env),
      scope: params,
      signal: requestSignal,
    });
    const result = await prepared.agent.invoke(prepared.input, {
      recursionLimit: RECURSION_LIMIT,
      signal: requestSignal,
    });
    assertCompletedAnswer(result.messages.at(-1));
    return prepared.result(result.structuredResponse);
  } catch (error) {
    throw toLlmError(error);
  } finally {
    // 並列ツールの一方が失敗しても、残りの検索をバックグラウンドに残さない。
    lifecycle.abort();
    await search.close();
  }
}

const searchProgressSchema = z.union([
  z.object({ searching: z.string(), searchId: z.number().int().positive() }),
  z.object({ searchCompleted: z.object({
    id: z.number().int().positive(), query: z.string(), count: z.number().int().nonnegative(),
  }) }),
]);
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
  const queryText = extractLatestUserQuery(params.messages);

  if (!hasAgentContext(params)) {
    const systemPrompt = buildNoCourseSystemPrompt(params.locale);
    for await (const chunk of streamReply(env, systemPrompt, queryText, signal, params.costLedger)) {
      if ("answer" in chunk) {
        yield { final: { queryText, retrievedContexts: [], answer: validateChatAnswer(chunk.answer, []) } };
      } else yield { part: { type: "text", ...chunk } };
    }
    return;
  }

  const lifecycle = new AbortController();
  const requestSignal = AbortSignal.any([
    deadlineSignal(llmTimeoutMs(env, true), signal),
    lifecycle.signal,
  ]);
  const search = lazySceneSearch(env, params, requestSignal);
  try {
    const prepared = prepareAgent(env, {
      search,
      queryText,
      timeoutMs: llmTimeoutMs(env, true),
      scope: params,
      signal: requestSignal,
      streaming: true,
    });

    const stream = await prepared.agent.stream(prepared.input, {
      streamMode: ["values", "custom"],
      signal: requestSignal,
      recursionLimit: RECURSION_LIMIT,
    });

    // Core assembles each model turn from native events, including scalar
    // finish metadata. Forward those events through the graph writer so tool
    // progress, error delivery and cancellation keep the same graph lifecycle.
    // Only segments[].text is displayed; tool preambles are not answer text.
    let messages: readonly BaseMessage[] = [];
    let structuredResponse: unknown;
    let parser = new AnswerContentStream();
    let toolTurn = false;
    let emittedAnswer = false;
    let sentSources = 0;
    for await (const [mode, chunk] of stream) {
      if (mode === "values") {
        messages = chunk.messages;
        structuredResponse = chunk.structuredResponse;
        continue;
      }
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

    assertCompletedAnswer(messages.at(-1));
    const final = prepared.result(structuredResponse);
    const { answer } = final;
    for (const source of answer.sources.slice(sentSources)) yield { source };
    for (const part of parser.finish(answer)) yield { part };
    yield { final };
  } catch (error) {
    throw toLlmError(error);
  } finally {
    // 送信失敗などで consumer が途中終了した場合も、検索の通信を止める。
    lifecycle.abort();
    await search.close();
  }
}
