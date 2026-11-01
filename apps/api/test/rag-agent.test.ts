import { applyChatPart, chatAnswerText, type ChatAnswer, type ChatContentPart } from "@videoq/trpc/chat";
import { embedding as testEmbedding } from "./helpers/embedding";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CourseDetail } from "../src/repositories/course-repository";
import { getCourseInfo } from "../src/repositories/course-repository";
import { MAX_COURSE_INFO_CALLS, COURSE_DESCRIPTION_LIMIT, VIDEO_DESCRIPTION_LIMIT } from "../src/lib/rag-course-info";
import type { SceneHit } from "../src/repositories/vector-repository";
import type { Bindings } from "../src/types/bindings";
import { LlmConfigurationError, LlmProviderError } from "../src/lib/openai";
import type { RagStreamChunk } from "../src/lib/rag";
import { LLM_STREAM_TIMEOUT_MS } from "../src/lib/llm";
import { chatCompletionFrames, chatCompletionResponse } from "./helpers/chat-completion-response";
import { stalledChatResponse } from "./helpers/stalled-chat-response";

/**
 * ReAct（createAgent + search_scenes）の振る舞い。
 * ベクトルストアは差し替え、OpenAI は tool_calls → 最終回答の 2 ターンを返す偽サーバで検証する。
 */

const searchCalls: string[] = [];
let closed = 0;
let opened = 0;
let closeError: Error | undefined;
let searchSignal: AbortSignal | undefined;
const videoSelections: (readonly number[] | undefined)[] = [];
let hitsByQuery: (query: string) => SceneHit[] | Promise<SceneHit[]>;

vi.mock("../src/repositories/vector-repository", () => ({
  openSceneSearch: async (_env: Bindings, _scope: unknown, signal?: AbortSignal) => {
    opened += 1;
    searchSignal = signal;
    return {
    search: async (query: string, videoIds?: readonly number[]) => {
      searchCalls.push(query);
      videoSelections.push(videoIds);
      return hitsByQuery(query);
    },
    close: async () => {
      closed += 1;
      if (closeError) throw closeError;
    },
    };
  },
}));

vi.mock("../src/repositories/course-repository", () => ({ getCourseInfo: vi.fn() }));

const { runRag, streamRag, MAX_SCENE_SEARCHES, MAX_TOOL_ROUNDS } = await import("../src/lib/rag");

const ENV = {
  OPENAI_API_KEY: "sk-test",
  OPENAI_BASE_URL: "https://openai.test/v1",
  HYPERDRIVE: { connectionString: "postgres://fake/db" },
} as unknown as Bindings;

const PARAMS = {
  messages: [{ role: "user", content: "pgvector とは？" }],
  ownerUserId: "00000000-0000-4000-8000-000000000005",
  videoIds: [60, 61],
  locale: "ja",
};

const scene = (n: number, videoId = 60): SceneHit => ({
  content: `scene ${n}`,
  videoId,
  videoTitle: `Video ${videoId}`,
  startTime: `00:0${n}:00`,
  endTime: `00:0${n}:30`,
});

const COURSE: CourseDetail = {
  id: 3, name: "デジタル回路", description: "回路の基礎を学ぶ講座", video_count: 2,
  display_order: 0, created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z",
  access_role: "owner", share_slug: "private-share-token",
  videos: [60, 61].map((id, index) => ({
    id, title: `第${index + 7}回`, description: `動画${id}の説明`, order: index * 10,
    status: "completed", file: "https://private.example/signed-url", tags: [],
    uploaded_at: "2026-09-14T00:00:00Z", source_type: "uploaded", source_url: null,
    youtube_video_id: null, youtube_embed_url: null,
  })),
};

beforeEach(() => {
  vi.mocked(getCourseInfo).mockReset().mockResolvedValue(COURSE);
});

type Turn =
  | { toolCall: { name: string; args: Record<string, unknown> }; preamble?: string }
  | { content: string; sourceIds?: number[] }
  | { status: number };

const jsonTurn = (turn: Exclude<Turn, { status: number }>) =>
  "toolCall" in turn
    ? {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: turn.preamble ?? null,
              tool_calls: [
                {
                  id: `call_${turn.toolCall.name}`,
                  type: "function",
                  function: {
                    name: turn.toolCall.name,
                    arguments: JSON.stringify({ ...(turn.toolCall.name === "search_scenes" ? { video_ids: null } : { video_limit: 20, video_offset: 0 }), ...turn.toolCall.args }),
                  },
                },
              ],
            },
          },
        ],
      }
    : {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ segments: [{ text: turn.content, sourceIds: turn.sourceIds ?? [] }] }) } }],
      };

/** 送信順に turns を返す偽 OpenAI。埋め込みは使われない想定だが念のため応答する。 */
function stubOpenAi(turns: Turn[], duplicateFinish = false) {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: testEmbedding(0.1, 0.2) }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const turn = turns[Math.min(index++, turns.length - 1)];
    if ("status" in turn) {
      return new Response("upstream failed", { status: turn.status });
    }
    if (body.stream && duplicateFinish) {
      const frames = chatCompletionFrames(jsonTurn(turn), `chatcmpl-${index}`);
      frames.splice(-2, 0, frames.at(-3)!);
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return chatCompletionResponse(jsonTurn(turn), body.stream, `chatcmpl-${index}`);
  });
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  searchCalls.length = 0;
  closed = 0;
  opened = 0;
  closeError = undefined;
  searchSignal = undefined;
  videoSelections.length = 0;
});

describe.each([false, true])("Q&A single-question contract (stream=%s)", (stream) => {
  it.each([true, false])("ignores earlier turns even when supplied (course=%s)", async (course) => {
    const bodies = stubOpenAi([{ content: "Which subject would you like an example of?" }]);
    const params = {
      ...PARAMS,
      ...(course ? {} : { ownerUserId: null, videoIds: [] }),
      messages: [
        { role: "user", content: "内積とは？" },
        { role: "assistant", content: "The dot product is…" },
        { role: "user", content: "具体例を教えて" },
      ],
    };
    if (stream) {
      for await (const _chunk of streamRag(ENV, params)) { /* consume the response */ }
    } else {
      await runRag(ENV, params);
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages).toEqual([
      expect.objectContaining({ role: "developer" }),
      expect.objectContaining({ role: "user", content: "具体例を教えて" }),
    ]);
  });
});

describe.each([false, true])("検索障害（stream=%s）", (stream) => {
  it("並列検索の一方が失敗したら残りの検索も中断する", async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<SceneHit[]>();
    const failure = new LlmProviderError("embedding failed");
    hitsByQuery = async (query) => {
      if (query === "fail") {
        await started.promise;
        throw failure;
      }
      searchSignal!.addEventListener("abort", () => pending.reject(searchSignal!.reason), { once: true });
      started.resolve();
      return pending.promise;
    };
    const upstream = vi.fn(async () => chatCompletionResponse({
      choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null,
        tool_calls: ["fail", "pending"].map((query) => ({
          id: `call_${query}`, type: "function",
          function: { name: "search_scenes", arguments: JSON.stringify({ query, video_ids: null }) },
        })),
      } }],
    }, stream));
    vi.stubGlobal("fetch", upstream);
    try {
      const execute = async () => {
        if (!stream) return runRag(ENV, PARAMS);
        for await (const _chunk of streamRag(ENV, PARAMS)) { /* consume */ }
      };
      await expect(execute()).rejects.toBe(failure);
      expect(searchSignal?.aborted).toBe(true);
      expect(upstream).toHaveBeenCalledOnce();
      expect(closed).toBe(1);
    } finally {
      pending.resolve([]);
    }
  });

  it("接続の後始末に失敗しても元の検索エラーを保つ", async () => {
    const original = new LlmConfigurationError("EMBEDDING_MODEL is required");
    closeError = new Error("pool close failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    hitsByQuery = () => { throw original; };
    stubOpenAi([{ toolCall: { name: "search_scenes", args: { query: "scene" } } }]);
    const execute = async () => {
      if (!stream) return runRag(ENV, PARAMS);
      for await (const _chunk of streamRag(ENV, PARAMS)) { /* consume */ }
    };
    await expect(execute()).rejects.toBe(original);
    expect(closed).toBe(1);
    expect(log).toHaveBeenCalledOnce();
  });

  it.each(["", "   "])("空の最終回答を検索前の前置きや成功扱いで補わない: %j", async (content) => {
    hitsByQuery = () => [scene(1)];
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "scene" } }, preamble: "調べますね。" },
      { content },
    ]);
    const chunks: RagStreamChunk[] = [];
    const execute = async () => {
      if (!stream) return runRag(ENV, PARAMS);
      for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
    };

    await expect(execute()).rejects.toThrow(LlmProviderError);
    expect(chunks.some((chunk) => "final" in chunk)).toBe(false);
    expect(chunks.flatMap(chunk => "part" in chunk && chunk.part.type === "text" ? [chunk.part.text] : []).join("").trim()).toBe("");
    expect(closed).toBe(1);
  });

  it("検索を実行しなかった動画指定エラーで検索枠を消費しない", async () => {
    hitsByQuery = () => [scene(1)];
    stubOpenAi([
      ...Array.from({ length: MAX_SCENE_SEARCHES }, (): Turn => ({
        toolCall: { name: "search_scenes", args: { query: "scene", video_ids: [999] } },
      })),
      { toolCall: { name: "search_scenes", args: { query: "scene", video_ids: [60] } } },
      { content: "回答 ", sourceIds: [1] },
    ]);

    if (stream) {
      const chunks: RagStreamChunk[] = [];
      for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
      expect(chunks.at(-1)).toMatchObject({ final: { answer: { sources: [{ video_id: 60 }] } } });
      expect(chunks).toContainEqual({ searching: "scene", searchId: 1 });
    } else {
      expect((await runRag(ENV, PARAMS)).answer.sources).toHaveLength(1);
    }
    expect(searchCalls).toEqual(["scene"]);
    expect(videoSelections).toEqual([[60]]);
    expect(closed).toBe(1);
  });

  it.each([
    new LlmProviderError("Private embeddings unreachable"),
    new LlmConfigurationError("EMBEDDING_MODEL is required"),
    new Error("database unavailable"),
  ])("検索例外を通常回答にせず送出し、接続を閉じる: %s", async (error) => {
    hitsByQuery = () => {
      throw error;
    };
    const bodies = stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "scene" } }, preamble: "調べますね。" },
      { content: "検索できませんでした。" },
    ]);

    const chunks: RagStreamChunk[] = [];
    const execute = async () => {
      if (!stream) return runRag(ENV, PARAMS);
      for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
    };
    await expect(execute()).rejects.toThrow(
      error instanceof LlmConfigurationError ? LlmConfigurationError : LlmProviderError,
    );
    expect(chunks.some((chunk) => "part" in chunk || "final" in chunk)).toBe(false);
    expect(searchCalls).toEqual(["scene"]);
    expect(bodies).toHaveLength(1);
    expect(closed).toBe(1);
  });

  it("検索失敗後はモデルを再度呼ばず、元の設定エラーを保つ", async () => {
    const error = new LlmConfigurationError("EMBEDDING_MODEL is required");
    hitsByQuery = () => {
      throw error;
    };
    const bodies = stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "scene" } } },
      { status: 503 },
    ]);

    const execute = async () => {
      if (!stream) return runRag(ENV, PARAMS);
      for await (const chunk of streamRag(ENV, PARAMS)) {
        expect(chunk).not.toHaveProperty("text");
        expect(chunk).not.toHaveProperty("final");
      }
    };
    await expect(execute()).rejects.toBe(error);
    expect(bodies).toHaveLength(1);
    expect(closed).toBe(1);
  });

  it("ツール引数の不備はモデルが修正して検索を続けられる", async () => {
    hitsByQuery = () => [scene(1)];
    const bodies = stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "" } } },
      { toolCall: { name: "search_scenes", args: { query: "scene" } } },
      { content: "回答 ", sourceIds: [1] },
    ]);

    if (stream) {
      const chunks: RagStreamChunk[] = [];
      for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
      expect(chunks.at(-1)).toMatchObject({ final: { answer: { sources: [{ video_id: 60 }] } } });
    } else {
      const result = await runRag(ENV, PARAMS);
      expect(chatAnswerText(result.answer)).toBe("回答 ");
      expect(result.answer.sources).toHaveLength(1);
    }

    expect(searchCalls).toEqual(["scene"]);
    expect(bodies).toHaveLength(3);
    expect(closed).toBe(1);
  });
});

describe.each([false, true])("プライベート OpenAI 互換 API（stream=%s）", (stream) => {
  it("/v1/chat/completions でツール検索から引用付き回答まで実行する", async () => {
    hitsByQuery = () => [scene(1)];
    const bodies = stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "scene" } } },
      { content: "回答 ", sourceIds: [1] },
    ]);
    const fetchStub = vi.fn(fetch);
    vi.stubGlobal("fetch", fetchStub);
    const env = {
      ...ENV,
      OPENAI_API_KEY: "local-inference",
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1/",
      LLM_MODEL: "qwen3-vl:8b-instruct",
    };

    if (stream) {
      const chunks: RagStreamChunk[] = [];
      for await (const chunk of streamRag(env, PARAMS)) chunks.push(chunk);
      expect(chunks.filter((chunk) => "part" in chunk && chunk.part.type === "text").map((chunk) => "part" in chunk && chunk.part.type === "text" ? chunk.part.text : "").join(""))
        .toBe("回答 ");
      expect(chunks.at(-1)).toMatchObject({ final: { answer: { sources: [{ video_id: 60 }] } } });
    } else {
      const result = await runRag(env, PARAMS);
      expect(chatAnswerText(result.answer)).toBe("回答 ");
      expect(result.answer.sources).toHaveLength(1);
    }

    expect(fetchStub).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchStub.mock.calls) {
      expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-inference");
    }
    for (const body of bodies) {
      expect(body.model).toBe(env.LLM_MODEL);
      expect(body.stream).toBe(stream);
      const messages = body.messages as { role: string; content: unknown }[];
      expect(typeof messages.find((message) => message.role === "system")?.content).toBe("string");
    }
    expect(searchCalls).toEqual(["scene"]);
    expect(closed).toBe(1);
  });
});

describe("RAG エージェント（非ストリーミング）", () => {
  it("search_scenes を呼んでから回答し、ヒットを sources に載せる", async () => {
    hitsByQuery = () => [scene(1), scene(2, 61)];
    const bodies = stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "pgvector 定義" } } },
      { content: "pgvector は  と  の通りです。", sourceIds: [1,2] },
    ]);

    const result = await runRag(ENV, PARAMS);

    expect(searchCalls).toEqual(["pgvector 定義"]);
    expect(chatAnswerText(result.answer)).toBe("pgvector は  と  の通りです。");
    expect(result.answer.sources).toEqual([
      { id: 1, video_id: 60, title: "Video 60", start_time: "00:01:00", end_time: "00:01:30" },
      { id: 2, video_id: 61, title: "Video 61", start_time: "00:02:00", end_time: "00:02:30" },
    ]);
    expect(result.retrievedContexts).toEqual(["scene 1", "scene 2"]);
    expect(closed).toBe(1);

    // 1 通目に search_scenes がツールとして渡っている。
    const tools = bodies[0].tools as { function: { name: string; parameters: unknown } }[];
    expect(tools.map((t) => t.function.name)).toEqual(["search_scenes", "read_video_window", "inspect_clip", "overview_video", "skim_video", "focus_clip"]);
    // 所有者スコープは非公開。動画IDは講座内でのみ指定できる。
    expect(JSON.stringify(tools[0].function.parameters)).not.toContain("user_id");
    expect(JSON.stringify(tools[0].function.parameters)).toContain("video_ids");
  });

  it("複数クエリのヒットは重複排除し、sourceId は回答全体で通し番号になる", async () => {
    // 1 回目と 2 回目で scene(1) が重複する。
    hitsByQuery = (query) => (query === "A" ? [scene(1), scene(2)] : [scene(1), scene(3)]);
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "A" } } },
      { toolCall: { name: "search_scenes", args: { query: "B" } } },
      { content: "答え ", sourceIds: [1,2,3] },
    ]);

    const result = await runRag(ENV, PARAMS);

    expect(searchCalls).toEqual(["A", "B"]);
    expect(result.answer.sources).toHaveLength(3);
    expect(result.answer.sources?.map((c) => c.start_time)).toEqual([
      "00:01:00",
      "00:02:00",
      "00:03:00",
    ]);
    expect(result.retrievedContexts).toEqual(["scene 1", "scene 2", "scene 3"]);
  });

  it("検索回数は MAX_SCENE_SEARCHES で打ち切り、回答は返す", async () => {
    hitsByQuery = () => [scene(1)];
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "q1" } } },
      { toolCall: { name: "search_scenes", args: { query: "q2" } } },
      { toolCall: { name: "search_scenes", args: { query: "q3" } } },
      { toolCall: { name: "search_scenes", args: { query: "q4" } } },
      { content: "打ち切り後の回答 ", sourceIds: [1] },
    ]);

    const result = await runRag(ENV, PARAMS);

    expect(searchCalls).toHaveLength(MAX_SCENE_SEARCHES);
    expect(chatAnswerText(result.answer)).toBe("打ち切り後の回答 ");
    expect(closed).toBe(1);
  });

  it("course が無い場合は検索せず単発の LLM 呼び出しになる", async () => {
    hitsByQuery = () => [];
    const bodies = stubOpenAi([{ content: "範囲外です。" }]);

    const result = await runRag(ENV, { ...PARAMS, videoIds: null });

    expect(searchCalls).toEqual([]);
    expect(closed).toBe(0);
    expect(result.answer.sources).toEqual([]);
    expect(bodies[0].tools).toBeUndefined();
  });
});

describe("RAG エージェント（ストリーミング）", () => {
  it("本文の送信を途中で打ち切った場合も上流の生成を中断する", async () => {
    let upstream: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      upstream = init.signal!;
      return stalledChatResponse(upstream, () => {}, true, '{"segments":[{"text":"First');
    });
    const stream = streamRag(ENV, PARAMS);
    try {
      expect((await stream.next()).value).toEqual({ part: { type: "text", segmentIndex: 0, text: "First" } });
      await stream.return();
      expect(upstream?.aborted).toBe(true);
    } finally { await stream.return(); }
  });

  it.each(["length", "content_filter", "refusal", "truncated", "tools_after_answer"])("本文を一部送信した後の %s を完成・保存可能な回答にしない", async reason => {
    const completion = jsonTurn({ content: "途中の回答。" });
    const choice = completion.choices[0];
    if (reason === "length" || reason === "content_filter") choice.finish_reason = reason;
    if (reason === "truncated") choice.message.content = '{"segments":[{"text":"途中の回答。';
    if (reason === "tools_after_answer") {
      choice.finish_reason = "tool_calls";
      choice.message.tool_calls = jsonTurn({ toolCall: { name: "search_scenes", args: { query: "late" } } }).choices[0].message.tool_calls;
    }
    const frames = chatCompletionFrames(completion);
    if (reason === "refusal") frames.splice(-3, 0, 'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"refusal":"refused"}}]}\n\n');
    const upstream = vi.fn(async () => new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", upstream);
    const chunks: RagStreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
    })()).rejects.toThrow(LlmProviderError);
    expect(chunks.some(chunk => "part" in chunk && chunk.part.type === "text" && chunk.part.text.length > 0)).toBe(true);
    expect(chunks.some(chunk => "final" in chunk)).toBe(false);
    expect(upstream).toHaveBeenCalledOnce();
    expect(searchCalls).toEqual([]);
  });

  it("モデルの残りを止めていても本文・引用が先に届き、同じ回答を2回の呼び出しで確定する", async () => {
    hitsByQuery = () => [scene(1)];
    const bodies = stubOpenAi([{ toolCall: { name: "search_scenes", args: { query: "scene" } } }]);
    const initialFetch = fetch;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let finalCalls = 0;
    const send = (content: string, finish_reason: string | null = null) => controller.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ id: "final-answer", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason }] })}\n\n`,
    ));
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (!body.messages.some((message: { role: string }) => message.role === "tool")) return initialFetch(url, init);
      expect(body.stream).toBe(true);
      finalCalls++;
      return new Response(new ReadableStream<Uint8Array>({ start(c) {
        controller = c;
        send('{"segments":[{"text":"前半の回答');
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    const stream = streamRag(ENV, PARAMS);
    const chunks: RagStreamChunk[] = [];
    const until = async (predicate: (chunk: RagStreamChunk) => boolean) => {
      for (;;) {
        const next = await stream.next();
        expect(next.done).toBe(false);
        chunks.push(next.value!);
        if (predicate(next.value!)) break;
      }
    };
    try {
      await until(chunk => "part" in chunk && chunk.part.type === "text" && chunk.part.text.includes("前半"));
      expect(chunks.some(chunk => "final" in chunk)).toBe(false);
      send('。","sourceIds":[1]}');
      await until(chunk => "part" in chunk && chunk.part.type === "citation");
      expect(chunks).toContainEqual({ source: { id: 1, video_id: 60, title: "Video 60", start_time: "00:01:00", end_time: "00:01:30" } });
      expect(chunks.some(chunk => "final" in chunk)).toBe(false);
      send(',{"text":" 後半の回答。","sourceIds":[1]}]}');
      send("", "stop");
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
      for await (const chunk of stream) chunks.push(chunk);
      const rendered: ChatAnswer = { segments: [], sources: [] };
      for (const chunk of chunks) {
        if ("part" in chunk) applyChatPart(rendered, chunk.part);
        if ("source" in chunk) rendered.sources.push(chunk.source);
      }
      expect(chunks.at(-1)).toMatchObject({ final: { answer: rendered } });
      expect(chatAnswerText(rendered)).toBe("前半の回答。 後半の回答。");
      expect(bodies.length + finalCalls).toBe(2);
    } finally {
      await stream.return();
    }
  });

  it("進捗の送信を途中で打ち切った場合も実行中の検索を中断する", async () => {
    const started = Promise.withResolvers<void>();
    const search = Promise.withResolvers<SceneHit[]>();
    hitsByQuery = () => {
      searchSignal!.addEventListener("abort", () => search.reject(searchSignal!.reason), { once: true });
      started.resolve();
      return search.promise;
    };
    const bodies = stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "scene" } } },
      { content: "生成してはいけない回答" },
    ]);
    const stream = streamRag(ENV, PARAMS);
    try {
      expect((await stream.next()).value).toEqual({ toolProgress: { type: "tool_progress", call_id: 1, tool: "search_scenes", status: "running" } });
      expect((await stream.next()).value).toEqual({ searching: "scene", searchId: 1 });
      await started.promise;
      await stream.return();
      expect(searchSignal?.aborted).toBe(true);
      expect(bodies).toHaveLength(1);
      expect(closed).toBe(1);
    } finally {
      search.resolve([]);
      await stream.return();
    }
  });

  it.each(["deadline", "client"])("検索中の %s 中断を検索接続にも渡し、次のモデルを呼ばない", async (source) => {
    const deadline = new AbortController();
    const client = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const started = Promise.withResolvers<void>();
    const search = Promise.withResolvers<SceneHit[]>();
    hitsByQuery = () => {
      searchSignal?.addEventListener("abort", () => search.reject(searchSignal!.reason), { once: true });
      started.resolve();
      return search.promise;
    };
    const bodies = stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "scene" } } },
      { content: "生成してはいけない回答" },
    ]);
    const chunks: RagStreamChunk[] = [];
    const consume = (async () => {
      for await (const chunk of streamRag(ENV, PARAMS, client.signal)) chunks.push(chunk);
    })();
    const rejected = expect(consume).rejects.toThrow();
    try {
      await started.promise;
      if (source === "deadline") deadline.abort(new DOMException("deadline reached", "TimeoutError"));
      else client.abort();
      expect(searchSignal?.aborted).toBe(true);
    } finally {
      search.resolve([]);
      await rejected;
    }
    expect(bodies).toHaveLength(1);
    expect(closed).toBe(1);
    expect(chunks.some((chunk) => "part" in chunk || "final" in chunk)).toBe(false);
  });

  it.each(["deadline", "client"])("検索後の本文受信中も %s で中断し、本文・final を送らず接続を閉じる", async (source) => {
    hitsByQuery = () => [scene(1)];
    const deadline = new AbortController();
    const client = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "scene" } } },
    ]);
    const initialFetch = fetch;
    let upstream: AbortSignal | undefined;
    const reading = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (!body.messages.some((message: { role: string }) => message.role === "tool")) {
        return initialFetch(url, init);
      }
      upstream = init.signal!;
      return stalledChatResponse(upstream, reading.resolve, true);
    });
    const chunks: RagStreamChunk[] = [];
    const consume = (async () => {
      for await (const chunk of streamRag(ENV, PARAMS, client.signal)) chunks.push(chunk);
    })();
    const rejected = expect(consume).rejects.toThrow();
    await reading.promise;
    if (source === "deadline") deadline.abort(new DOMException("deadline reached", "TimeoutError"));
    else client.abort();
    await rejected;
    expect(upstream?.aborted).toBe(true);
    expect(timeout).toHaveBeenCalledWith(LLM_STREAM_TIMEOUT_MS);
    expect(chunks.some((chunk) => "part" in chunk || "final" in chunk)).toBe(false);
    expect(searchCalls).toEqual(["scene"]);
    expect(closed).toBe(1);
  });

  it("複数の検索ターンの前置きを除外し、最終回答だけを返す", async () => {
    hitsByQuery = () => [scene(1)];
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "A" } }, preamble: "調べますね。" },
      { toolCall: { name: "search_scenes", args: { query: "B" } }, preamble: "追加で調べます。" },
      { content: "最終回答 ", sourceIds: [1] },
    ]);
    const chunks: RagStreamChunk[] = [];
    for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
    expect(chunks.filter((chunk) => "part" in chunk && chunk.part.type === "text").map((chunk) => "part" in chunk && chunk.part.type === "text" ? chunk.part.text : "").join(""))
      .toBe("最終回答 ");
    expect(chunks.filter((chunk) => "searching" in chunk))
      .toEqual([{ searching: "A", searchId: 1 }, { searching: "B", searchId: 2 }]);
    expect(chunks.at(-1)).toMatchObject({ final: { answer: { sources: [{ video_id: 60 }] } } });
    expect(closed).toBe(1);
  });

  it("検索イベント → 回答本文 → final の順に流す", async () => {
    hitsByQuery = () => [scene(1)];
    stubOpenAi(
      [
        { toolCall: { name: "search_scenes", args: { query: "検索語" } } },
        { content: "回答本文" },
      ],
    );

    const chunks: RagStreamChunk[] = [];
    for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);

    const searching = chunks.filter((c) => typeof c === "object" && c !== null && "searching" in c);
    expect(searching).toEqual([{ searching: "検索語", searchId: 1 }]);
    expect(chunks).toContainEqual({ searchCompleted: { id: 1, query: "検索語", count: 1 } });

    const parts = chunks.filter((c) => "part" in c).map(c => c.part);
    expect(parts.filter(p => p.type === "text").map(p => p.text).join("")).toBe("回答本文");
    const last = chunks.at(-1)!;
    expect(last).toMatchObject({ final: { answer: { sources: [{ id: 1, video_id: 60 }] } } });
    expect(chunks.findIndex(c => "source" in c)).toBeLessThan(chunks.findIndex(c => "part" in c));
    expect(closed).toBe(1);
  });

  it("検索が終わる前に開始を通知し、完了後に候補数を通知する", async () => {
    let finishSearch!: (hits: SceneHit[]) => void;
    hitsByQuery = () => new Promise<SceneHit[]>((resolve) => { finishSearch = resolve; });
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "時間のかかる検索" } } },
      { content: "回答 ", sourceIds: [1] },
    ]);
    const stream = streamRag(ENV, PARAMS);
    try {
      const first = await stream.next();
      expect(first.value).toEqual({ toolProgress: { type: "tool_progress", call_id: 1, tool: "search_scenes", status: "running" } });
      expect((await stream.next()).value).toEqual({ searching: "時間のかかる検索", searchId: 1 });
      finishSearch([scene(1)]);
      const remaining: RagStreamChunk[] = [];
      for await (const chunk of stream) remaining.push(chunk);
      expect(remaining[0]).toEqual({ searchCompleted: { id: 1, query: "時間のかかる検索", count: 1 } });
      expect(remaining[1]).toEqual({ toolProgress: { type: "tool_progress", call_id: 1, tool: "search_scenes", status: "complete" } });
      expect(remaining.at(-1)).toHaveProperty("final");
    } finally {
      finishSearch?.([]);
      await stream.return();
    }
  });

  it("completes retrieval and a cited answer with repeated provider finish notifications", async () => {
    hitsByQuery = () => [scene(1)];
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "量子化とは" } } },
      { content: "連続値を離散値に変換します。", sourceIds: [1] },
    ], true);
    const chunks: RagStreamChunk[] = [];
    for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ final: { answer: {
      segments: [{ text: "連続値を離散値に変換します。", sourceIds: [1] }],
    } } });
    expect(chunks.filter(chunk => "part" in chunk && chunk.part.type === "citation")).toHaveLength(1);
    expect(closed).toBe(1);
  });

  it("reports a failed tool without exposing its exception or generating a final answer", async () => {
    hitsByQuery = () => { throw new Error("private database error"); };
    stubOpenAi([{ toolCall: { name: "search_scenes", args: { query: "scene" } } }]);
    const chunks: RagStreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of streamRag(ENV, PARAMS)) chunks.push(chunk);
    })()).rejects.toThrow();
    expect(chunks.filter(chunk => "toolProgress" in chunk)).toEqual([
      { toolProgress: { type: "tool_progress", call_id: 1, tool: "search_scenes", status: "running" } },
      { toolProgress: { type: "tool_progress", call_id: 1, tool: "search_scenes", status: "error" } },
    ]);
    expect(JSON.stringify(chunks)).not.toContain("private database error");
    expect(chunks.some(chunk => "final" in chunk)).toBe(false);
  });
});

describe.each([false, true])("講座メタ情報（stream=%s）", (streaming) => {
  const execute = async (overrides: Partial<Parameters<typeof runRag>[1]> = {}) => {
    const params = { ...PARAMS, courseId: 3, ...overrides };
    if (!streaming) return runRag(ENV, params);
    const chunks: RagStreamChunk[] = [];
    for await (const chunk of streamRag(ENV, params)) chunks.push(chunk);
    const final = chunks.find((chunk) => "final" in chunk);
    return {
      ...final!.final,
      content: chunks.filter((chunk) => "part" in chunk && chunk.part.type === "text").map((chunk) => "part" in chunk && chunk.part.type === "text" ? chunk.part.text : "").join(""),
    };
  };
  const toolResults = (body: Record<string, unknown>) =>
    (body.messages as { role: string; content: string }[])
      .filter((message) => message.role === "tool").map((message) => message.content);

  it("メタ情報だけで回答し、検索接続を開かず、機密情報や架空の引用を根拠に含めない", async () => {
    const bodies = stubOpenAi([
      { toolCall: { name: "get_course_info", args: {} }, preamble: "確認します。" },
      { content: "デジタル回路は2本の動画で構成されています。" },
    ]);
    const result = await execute({ messages: [{ role: "user", content: "この講座の名前と動画数は？" }] });
    expect(chatAnswerText(result.answer)).toBe("デジタル回路は2本の動画で構成されています。");
    expect(result.answer.sources).toEqual([]);
    expect(opened).toBe(0);
    expect(closed).toBe(0);
    expect(searchCalls).toEqual([]);
    expect(getCourseInfo).toHaveBeenCalledWith(ENV, 3, PARAMS.ownerUserId, {
      videoLimit: 20, videoOffset: 0,
      courseDescriptionLimit: COURSE_DESCRIPTION_LIMIT,
      videoDescriptionLimit: VIDEO_DESCRIPTION_LIMIT,
    });
    const context = JSON.parse(toolResults(bodies[1])[0]);
    expect(context).toMatchObject({ name: COURSE.name, video_count: 2,
      videos: [{ id: 60, position: 1, order: 0 }, { id: 61, position: 2, order: 10 }],
      videos_meta: { total: 2, has_more: false, next_offset: null },
    });
    expect(result.retrievedContexts).toHaveLength(1);
    expect(result.retrievedContexts[0]).toContain("Course metadata");
    for (const secret of ["private-share-token", "signed-url", PARAMS.ownerUserId]) {
      expect(JSON.stringify(bodies)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it.each(["empty", "processing"])("%s の講座でも説明未登録と本数・処理状態を取得できる", async (state) => {
    vi.mocked(getCourseInfo).mockResolvedValue({ ...COURSE, description: "",
      video_count: state === "empty" ? 0 : 1,
      videos: state === "empty" ? [] : [{ ...COURSE.videos[0], description: "", status: "processing" }],
    });
    const bodies = stubOpenAi([
      { toolCall: { name: "get_course_info", args: {} } },
      { content: "説明文は登録されていません。" },
    ]);
    const result = await execute({ videoIds: state === "empty" ? [] : [60] });
    expect(chatAnswerText(result.answer)).toBe("説明文は登録されていません。");
    const metadata = JSON.parse(toolResults(bodies[1])[0]);
    expect(metadata.description).toBe("");
    expect(metadata.video_count).toBe(state === "empty" ? 0 : 1);
    if (state === "processing") expect(metadata.videos[0].status).toBe("processing");
    expect(opened).toBe(0);
  });

  it("2ページ目で特定した動画を指定して検索し、シーン引用を保持する", async () => {
    vi.mocked(getCourseInfo)
      .mockResolvedValueOnce({ ...COURSE, videos: [COURSE.videos[0]] })
      .mockResolvedValueOnce({ ...COURSE, videos: [COURSE.videos[1]] });
    hitsByQuery = () => [scene(1, 61)];
    const bodies = stubOpenAi([
      { toolCall: { name: "get_course_info", args: { video_limit: 1 } } },
      { toolCall: { name: "get_course_info", args: { video_limit: 1, video_offset: 1 } } },
      { toolCall: { name: "search_scenes", args: { query: "回路の説明", video_ids: [61] } } },
      { content: "第8回の説明です 。", sourceIds: [1] },
    ]);
    const result = await execute();
    expect(JSON.parse(toolResults(bodies[1])[0])).toMatchObject({
      video_count: 2, videos_meta: { total: 2, has_more: true, next_offset: 1 },
    });
    expect(JSON.parse(toolResults(bodies[2])[1])).toMatchObject({
      videos: [{ id: 61, position: 2 }], videos_meta: { total: 2, has_more: false, next_offset: null },
    });
    expect(videoSelections).toEqual([[61]]);
    expect(result.answer.sources).toEqual([{ id: 1, video_id: 61, title: "Video 61", start_time: "00:01:00", end_time: "00:01:30" }]);
    expect(result.retrievedContexts).toHaveLength(3);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it.each([[999], [60, 999], [], [-1]].map((video_ids) => ({ video_ids })))
    ("不正な動画指定 $video_ids を検索せずモデルへ返す", async ({ video_ids }) => {
    stubOpenAi([
      { toolCall: { name: "search_scenes", args: { query: "private", video_ids } } },
      { content: "指定された動画を検索できません。" },
    ]);
    const result = await execute();
    expect(result.answer.sources).toEqual([]);
    expect(opened).toBe(0);
    expect(searchCalls).toEqual([]);
  });

  it("モデル引数による講座ID差し替えを受け付けず、正しい引数で再試行できる", async () => {
    stubOpenAi([
      { toolCall: { name: "get_course_info", args: { course_id: 999 } } },
      { toolCall: { name: "get_course_info", args: {} } },
      { content: "デジタル回路です。" },
    ]);
    await execute();
    expect(getCourseInfo).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getCourseInfo).mock.calls[0][1]).toBe(3);
  });

  it("長い説明文を上限で切り、取得済み根拠にも省略を明示する", async () => {
    vi.mocked(getCourseInfo).mockResolvedValue({ ...COURSE,
      description: "あ".repeat(COURSE_DESCRIPTION_LIMIT + 1),
      videos: [{ ...COURSE.videos[0], description: "い".repeat(VIDEO_DESCRIPTION_LIMIT + 1) }],
    });
    const bodies = stubOpenAi([
      { toolCall: { name: "get_course_info", args: {} } }, { content: "説明の一部です。" },
    ]);
    await execute();
    const metadata = JSON.parse(toolResults(bodies[1])[0]);
    expect(metadata.description).toHaveLength(COURSE_DESCRIPTION_LIMIT);
    expect(metadata.description_truncated).toBe(true);
    expect(metadata.videos[0].description).toHaveLength(VIDEO_DESCRIPTION_LIMIT);
    expect(metadata.videos[0].description_truncated).toBe(true);
  });

  it("取得回数を制限し、最終回答を返す", async () => {
    stubOpenAi([
      ...Array.from({ length: MAX_COURSE_INFO_CALLS + 1 }, (): Turn => ({
        toolCall: { name: "get_course_info", args: {} },
      })),
      { content: "取得済みの講座情報です。" },
    ]);
    const result = await execute();
    expect(getCourseInfo).toHaveBeenCalledTimes(MAX_COURSE_INFO_CALLS);
    expect(chatAnswerText(result.answer)).toBe("取得済みの講座情報です。");
    expect(result.retrievedContexts).toHaveLength(1);
  });

  it("引数不備が続いても最終ターンはツールを外して回答させる", async () => {
    const bodies = stubOpenAi([
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (): Turn => ({
        toolCall: { name: "get_course_info", args: { video_limit: 999 } },
      })),
      { content: "講座情報を取得できませんでした。" },
    ]);
    const result = await execute();
    expect(chatAnswerText(result.answer)).toBe("講座情報を取得できませんでした。");
    expect(bodies.at(-1)?.tools ?? []).toEqual([]);
    expect(getCourseInfo).not.toHaveBeenCalled();
    expect(opened).toBe(0);
  });

  it("メタ情報取得のDB障害では回答を生成せず例外を伝える", async () => {
    vi.mocked(getCourseInfo).mockRejectedValue(new Error("database unavailable"));
    const bodies = stubOpenAi([
      { toolCall: { name: "get_course_info", args: {} }, preamble: "確認します。" },
      { content: "誤った成功回答" },
    ]);
    await expect(execute()).rejects.toThrow(LlmProviderError);
    expect(bodies).toHaveLength(1);
    expect(opened).toBe(0);
  });
});
