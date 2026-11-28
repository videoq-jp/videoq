import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { requestBodyText } from "./helpers/request-body";
import { chatCompletionResponse } from "./helpers/chat-completion-response";
import { getCourseInfo } from "../src/repositories/course-repository";
import type { Bindings } from "../src/types/bindings";
let authorizedScope: unknown;
let duplicateTitles = false;
let catalogSize = 2;
let pageSize = 20;
let plannerOffset = 0;
let lectureTitles = false;
const fixture = vi.hoisted(() => ({ search: vi.fn(), close: vi.fn() }));
vi.mock("../src/repositories/vector-repository", () => ({ openSceneSearch: async (_env: unknown, scope: unknown) => {
  authorizedScope = scope; return { search: fixture.search, close: fixture.close };
} }));
vi.mock("../src/repositories/course-repository", () => ({ getCourseInfo: vi.fn() }));
vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: async (_env: unknown, _scope: unknown, id: number) => ({
  id, title: "CNN LeNet", fileKey: "fixture", sourceType: "uploaded", transcriptTooLarge: false,
  transcript: "1\n00:01:00,000 --> 00:01:30,000\nWINDOW_EVIDENCE: LeNet uses convolutions.",
}) }));
const { runRag, streamRag } = await import("../src/lib/rag");
const env = { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://openai.test/v1" } as Bindings;
const params = { ownerUserId: "00000000-0000-4000-8000-000000000005", courseId: 3,
  videoIds: [60, 61], locale: "ja", messages: [{ role: "user", content: "GPTとは" }] };
const hit = { videoId: 61, videoTitle: "CNN LeNet", startTime: "00:01:00", endTime: "00:02:00", content: "fixture evidence" };
let order: string[];
let requests: Record<string, any>[];
let plan: { requested_video: string | null; query: string; video_ids: number[] | null };
let answerTurns: Record<string, unknown>[];
let planTools: boolean;
function response(content: unknown) { return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }] }; }
function tool(name: string, args: unknown, id = "additional") { return { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }; }
const answer = () => response({ segments: [{ text: "Fixture answer", sourceIds: [1] }] });
beforeEach(() => {
  order = []; requests = []; planTools = false; duplicateTitles = false;
  catalogSize = 2; pageSize = 20; plannerOffset = 0; lectureTitles = false;
  vi.mocked(getCourseInfo).mockReset().mockImplementation(async (_env, _id, _owner, options) => ({
    name: "Mixed course", description: "", video_count: catalogSize,
    videos: Array.from({ length: catalogSize }, (_, index) => ({ id: index + 60,
      title: lectureTitles ? `第${index + 7}回 論理回路` : duplicateTitles ? "CNN LeNet" : index === 0 ? "TypeScript" : "CNN LeNet",
      description: "", order: index, status: "completed" })).slice(options.videoOffset, options.videoOffset + Math.min(pageSize, options.videoLimit)),
  }));
  plan = { requested_video: null, query: "GPT Generative Pre-trained Transformer", video_ids: null };
  answerTurns = [answer()]; fixture.close.mockReset();
  fixture.search.mockReset().mockImplementation(async () => { order.push("search"); return [hit]; });
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(requestBodyText(init.body)); requests.push(body);
    const planning = JSON.stringify(body.response_format).includes('"requested_video"');
    let value;
    if (planning) {
      order.push("plan");
      if (planTools) { planTools = false; value = tool("get_course_info", { video_limit: 20, video_offset: plannerOffset }, "catalog"); }
      else value = response(plan);
    } else { order.push("answer"); value = answerTurns.shift() ?? answer(); }
    return chatCompletionResponse(value, body.stream, `request-${requests.length}`);
  });
});
afterEach(() => vi.unstubAllGlobals());
async function execute(stream: boolean, overrides: Partial<Parameters<typeof runRag>[1]> = {}) {
  const input = { ...params, ...overrides };
  if (!stream) return { result: await runRag(env, input), chunks: [] as any[] };
  const chunks = [];
  for await (const chunk of streamRag(env, input)) chunks.push(chunk);
  return { result: chunks.find(chunk => "final" in chunk)?.final, chunks };
}
describe.each([false, true])("mandatory scene retrieval (stream=%s)", stream => {
  it.each(["TypeScriptとは", "CNNとは", "GPTとは"])("searches before answer after a topic switch: %s", async question => {
    plan.query = question;
    const { result, chunks } = await execute(stream, { messages: [
      { role: "user", content: "TypeScriptの動画について" },
      { role: "assistant", content: "CNNとGPTは講座に含まれません。" }, { role: "user", content: question },
    ] });
    expect(order).toEqual(["plan", "search", "answer"]);
    expect(fixture.search).toHaveBeenCalledWith(question, undefined, expect.any(AbortSignal));
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("sourceId");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("fixture evidence");
    if (!stream) expect(result?.answer.sources).toHaveLength(1);
    else expect(JSON.stringify(chunks)).toContain("searchCompleted");
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });
  it.each(["動画ID60ではなく動画ID61の内容を教えて", "動画ID999ではなく動画ID61の内容を教えて"])("excludes corrected ID mentions: %s", async content => {
    plan = { requested_video: "CNN LeNet", query: "CNN", video_ids: [61] };
    await execute(stream, { messages: [{ role: "user", content }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([61]);
  });
  it.each(["動画ID `999` の内容", '動画ID "999" の内容', "動画ID「999」の内容", "動画ID unknown の内容"])("fails closed for formatted or unresolved IDs: %s", async content => {
    await expect(execute(stream, { messages: [{ role: "user", content }] })).rejects.toMatchObject({ name: "VideoSelectionError" });
    expect(fixture.search).not.toHaveBeenCalled(); expect(order).not.toContain("answer");
  });
  it.each(["動画ID `61` の内容", '動画ID "61" の内容', "動画ID `61` の内容は何ですか？"])("preserves formatted authorized IDs: %s", async content => {
    await execute(stream, { messages: [{ role: "user", content }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([61]);
  });
  it.each(["動画IDという用語の意味は？", "動画IDとは？", "What is a video ID?", "以前の発言「動画ID999」の引用について説明して"])("does not select descriptive mentions: %s", async content => {
    await execute(stream, { messages: [{ role: "user", content }] });
    expect(fixture.search.mock.calls[0][1]).toBeUndefined();
  });
  it("validates a list position independently of duplicate titles", async () => {
    duplicateTitles = true; planTools = true;
    plan = { requested_video: "CNN LeNet", query: "CNN", video_ids: [61] };
    await execute(stream, { messages: [{ role: "user", content: "2本目の動画の内容を教えて" }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([61]);
  });
  it("restores the latest confirmed scope in a large course and resets for new topics", async () => {
    const saver = new MemorySaver(); catalogSize = 120;
    const videoIds = Array.from({ length: 120 }, (_, i) => i + 60);
    let checkpointId: string | null = null;
    for (const [content, scope] of [["動画ID60の内容", [60]], ["動画ID61の内容", [61]], ["この動画の具体例", [61]], ["具体例は？", [61]], ["なぜGPTは文章を生成できる？", null], ["GPTとは", null], ["この動画ではなく講座全体の概要", null]] as const) {
      plan = { requested_video: scope ? "CNN LeNet" : null, query: content, video_ids: scope ? [...scope] : null };
      const { result } = await execute(stream, { videoIds, messages: [{ role: "user", content }], memory: { saver, threadId: "large", checkpointId } });
      checkpointId = result!.checkpointId!;
      const saved = await saver.get({ configurable: { thread_id: "large", checkpoint_id: checkpointId } });
      expect(saved?.channel_values.confirmedSearchScope).toEqual({ videoIds: scope ? [...scope] : null });
      if (content === "動画ID61の内容") {
        // Simulate native history removed by compaction: the established scope
        // must survive independently of tool messages and accumulated citations.
        const tuple = (await saver.getTuple({ configurable: { thread_id: "large", checkpoint_id: checkpointId } }))!;
        const compacted = await saver.put(tuple.config, { ...tuple.checkpoint,
          channel_values: { ...tuple.checkpoint.channel_values, messages: [] },
        }, tuple.metadata!, {});
        checkpointId = compacted.configurable!.checkpoint_id as string;
      }
      expect(fixture.search.mock.calls.at(-1)![1]).toEqual(scope ? [...scope] : undefined);
    }
    expect(getCourseInfo).not.toHaveBeenCalled();
  });
  it.each(["動画ID60か動画ID61の内容", "動画ID60ではない動画の内容", "動画ID60と動画ID unknownの内容"])("does not turn ambiguous mentions into a selection: %s", async content => {
    await expect(execute(stream, { messages: [{ role: "user", content }] })).rejects.toMatchObject({ name: "VideoSelectionError" });
    expect(fixture.search).not.toHaveBeenCalled();
  });
  it("does not let historical quotes erase a current inaccessible selection", async () => {
    await expect(execute(stream, { messages: [{ role: "user", content: '以前の発言「動画ID60」を引用します。動画ID `999` の内容を教えて' }] })).rejects.toMatchObject({ name: "VideoSelectionError" });
    expect(fixture.search).not.toHaveBeenCalled();
  });
  it("resolves an unlabelled correction without selecting the excluded ID", async () => {
    await execute(stream, { messages: [{ role: "user", content: "動画ID999ではなく61の内容" }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([61]);
  });
  it("uses registered lecture numbers rather than list positions", async () => {
    lectureTitles = true; planTools = true;
    plan = { requested_video: "第8回 論理回路", query: "論理回路", video_ids: [61] };
    await execute(stream, { messages: [{ role: "user", content: "第8回の内容を説明して" }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([61]);
  });
  it("rejects an ID inferred from the lecture number as a list position", async () => {
    lectureTitles = true; planTools = true;
    plan = { requested_video: "第8回 論理回路", query: "論理回路", video_ids: [60] };
    await expect(execute(stream, { messages: [{ role: "user", content: "第8回の内容" }] })).rejects.toMatchObject({ name: "VideoSelectionError" });
    expect(fixture.search).not.toHaveBeenCalled();
  });
  it("resolves a positional selection even when the planner drops it", async () => {
    await execute(stream, { messages: [{ role: "user", content: "2本目の動画の内容" }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([61]);
  });
  it("resolves a lecture selection even when the planner drops it", async () => {
    lectureTitles = true;
    await execute(stream, { messages: [{ role: "user", content: "第8回の内容" }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([61]);
  });
  it("identifies a video with metadata and constrains additional searches", async () => {
    planTools = true; plan = { requested_video: "CNN LeNetの動画", query: "LeNet", video_ids: [61] };
    answerTurns = [tool("search_scenes", { query: "CNN", video_ids: null }), answer()];
    await execute(stream, { messages: [{ role: "user", content: "CNN LeNetの動画を説明して" }] });
    expect(fixture.search.mock.calls.map(call => call.slice(0, 2))).toEqual([["LeNet", [61]], ["CNN", [61]]]);
    expect(authorizedScope).toMatchObject({ videoIds: [60, 61] });
  });
  it("resolves a unique registered title when the planner omits its numeric ID", async () => {
    planTools = true; plan = { requested_video: "CNN LeNet", query: "LeNet", video_ids: null };
    await execute(stream, { messages: [{ role: "user", content: "CNN LeNetの動画について" }] });
    expect(fixture.search.mock.calls[0].slice(0, 2)).toEqual(["LeNet", [61]]);
  });
  it("does not widen an ambiguous title selection", async () => {
    duplicateTitles = true; planTools = true;
    plan = { requested_video: "CNN LeNet", query: "LeNet", video_ids: null };
    await expect(execute(stream, { messages: [{ role: "user", content: "CNN LeNetの動画について" }] })).rejects.toThrow();
    expect(fixture.search).not.toHaveBeenCalled(); expect(order).not.toContain("answer");
  });
  it.each([
    { requested_video: "unknown video", query: "unknown video", video_ids: null },
    { requested_video: "CNN LeNetの動画", query: "private video", video_ids: [999] },
    { requested_video: "GPTとは", query: "invented video", video_ids: [60] },
  ])("does not broaden unresolved or unauthorized selection: %j", async invalid => {
    plan = invalid; await expect(execute(stream)).rejects.toThrow();
    expect(fixture.search).not.toHaveBeenCalled(); expect(order).not.toContain("answer");
  });
  it.each(["動画ID 999の内容", "video ID: 999", "ID 999", "動画ID 60,999の説明", "動画ID -1", "動画ID 60.5", "動画ID 60と999"])("blocks an inaccessible explicit ID despite a dropped plan: %s", async question => {
    await expect(execute(stream, { messages: [{ role: "user", content: question }] })).rejects.toMatchObject({ name: "VideoSelectionError", reason: "out_of_scope" });
    expect(fixture.search).not.toHaveBeenCalled(); expect(order).not.toContain("answer");
  });
  it("retains authorized explicit IDs even when the planner erases or changes them", async () => {
    plan.video_ids = [60]; plan.requested_video = "other video";
    await execute(stream, { messages: [{ role: "user", content: "動画ID 61について" }] });
    expect(fixture.search.mock.calls[0].slice(0, 2)).toEqual([plan.query, [61]]);
  });
  it("keeps all explicitly selected IDs instead of treating the authorization list as a selection", async () => {
    await execute(stream, { messages: [{ role: "user", content: "video IDs 60 and 61について" }] });
    expect(fixture.search.mock.calls[0][1]).toEqual([60, 61]);
  });
  it("does not carry an old explicit ID into a new standalone topic", async () => {
    await execute(stream, { messages: [{ role: "user", content: "動画ID 999" }, { role: "assistant", content: "Specify a video" }, { role: "user", content: "GPTとは" }] });
    expect(fixture.search.mock.calls[0][1]).toBeUndefined();
  });
  it("checks hidden duplicate titles on the next page even with model-supplied IDs", async () => {
    duplicateTitles = true; pageSize = 1; planTools = true;
    plan = { requested_video: "CNN LeNet", query: "CNN", video_ids: [60] };
    await expect(execute(stream)).rejects.toMatchObject({ name: "VideoSelectionError" });
    expect(getCourseInfo).toHaveBeenCalledTimes(2); expect(fixture.search).not.toHaveBeenCalled();
  });
  it("completes pagination before filling a unique title's ID", async () => {
    pageSize = 1; planTools = true; plan = { requested_video: "TypeScript", query: "TypeScript", video_ids: null };
    await execute(stream);
    expect(getCourseInfo).toHaveBeenCalledTimes(2);
    expect(fixture.search.mock.calls[0][1]).toEqual([60]);
  });
  it("does not treat a terminal page as a complete catalog", async () => {
    plannerOffset = 1; duplicateTitles = true; planTools = true;
    plan = { requested_video: "CNN LeNet", query: "CNN", video_ids: null };
    await expect(execute(stream)).rejects.toMatchObject({ name: "VideoSelectionError" });
    expect(getCourseInfo).toHaveBeenCalledTimes(2); expect(fixture.search).not.toHaveBeenCalled();
  });
  it("asks for clarification when the shared metadata budget cannot complete the catalog", async () => {
    catalogSize = 120; planTools = true; plan = { requested_video: "TypeScript", query: "TypeScript", video_ids: null };
    await expect(execute(stream)).rejects.toMatchObject({ name: "VideoSelectionError" });
    expect(getCourseInfo).toHaveBeenCalledTimes(5); expect(fixture.search).not.toHaveBeenCalled();
    expect(order).not.toContain("answer");
  });
  it("counts the mandatory search in the same three-search budget", async () => {
    answerTurns = [1, 2, 3].map(n => tool("search_scenes", { query: `extra ${n}`, video_ids: null }, `extra${n}`));
    answerTurns.push(answer()); await execute(stream);
    expect(fixture.search).toHaveBeenCalledTimes(3);
    expect(fixture.search.mock.calls.map(call => call[0])).toEqual([plan.query, "extra 1", "extra 2"]);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Search limit reached");
  });
  it("passes zero-hit limitations to ReAct and permits further investigation", async () => {
    fixture.search.mockResolvedValueOnce([]);
    answerTurns = [tool("search_scenes", { query: "Transformer", video_ids: null }), answer()];
    await execute(stream); expect(fixture.search).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("does not establish absence from the course");
  });
  it("propagates an aborted search without generating an answer", async () => {
    fixture.search.mockRejectedValue(new DOMException("Search aborted", "AbortError"));
    await expect(execute(stream)).rejects.toThrow();
    expect(order).not.toContain("answer"); expect(fixture.close).toHaveBeenCalledTimes(1);
  });
  it("propagates search failure without generating an absence answer", async () => {
    fixture.search.mockRejectedValue(new Error("search unavailable"));
    await expect(execute(stream)).rejects.toThrow(); expect(order).not.toContain("answer");
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });
  it("preserves ReAct subtitle navigation after initial retrieval", async () => {
    answerTurns = [tool("read_video_window", { video_id: 61, start_seconds: 60, end_seconds: 90, context_seconds: 0 }), answer()];
    await execute(stream);
    expect(fixture.search).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("WINDOW_EVIDENCE");
  });
  it("rejects an additional search outside the selected video", async () => {
    planTools = false; plan = { requested_video: "ID 61", query: "CNN", video_ids: [61] };
    answerTurns = [tool("search_scenes", { query: "TypeScript", video_ids: [60] })];
    await expect(execute(stream, { messages: [{ role: "user", content: "ID 61の内容" }] })).rejects.toThrow(); expect(fixture.search).toHaveBeenCalledTimes(1);
  });
});
it("restores checkpoint history for follow-ups and persists native evidence/citation IDs", async () => {
  const saver = new MemorySaver();
  const first = await runRag(env, { ...params, memory: { saver, threadId: "mandatory", checkpointId: null } });
  const checkpointId = first.checkpointId!;
  expect(checkpointId).toBeTruthy(); plan.query = "GPTの具体例";
  await runRag(env, { ...params, messages: [{ role: "user", content: "具体例は？" }],
    memory: { saver, threadId: "mandatory", checkpointId } });
  const planning = requests.filter(request => JSON.stringify(request.response_format).includes('"requested_video"')).at(-1)!;
  expect(JSON.stringify(planning.messages)).toContain("GPTとは");
  expect(JSON.stringify(planning.messages)).toContain("具体例は？"); expect(fixture.search).toHaveBeenCalledTimes(2);
  const saved = await saver.get({ configurable: { thread_id: "mandatory" } });
  expect(JSON.stringify(saved?.channel_values)).toContain("initial_search_");
  expect(JSON.stringify(saved?.channel_values)).toContain("evidenceSources");
});
it("does not inherit a confirmed selection when resetting a conversation", async () => {
  const saver = new MemorySaver();
  await runRag(env, { ...params, messages: [{role: "user", content: "動画ID61の内容"}], memory: { saver, threadId: "reset", checkpointId: null } });
  await expect(runRag(env, { ...params, messages: [{role: "user", content: "この動画の具体例"}], memory: { saver, threadId: "reset", checkpointId: null } })).rejects.toMatchObject({ name: "VideoSelectionError" });
  expect(fixture.search).toHaveBeenCalledTimes(1);
});
it("cancels mandatory search before invoking the answer model", async () => {
  const controller = new AbortController();
  fixture.search.mockImplementation(async () => { controller.abort(); return [hit]; });
  await expect((async () => { for await (const _chunk of streamRag(env, params, controller.signal)) { /* consume */ } })()).rejects.toThrow();
  expect(order).not.toContain("answer"); expect(fixture.close).toHaveBeenCalledTimes(1);
});

it.each([false, true])("preserves citation identities while narrowing a checkpoint follow-up (stream=%s)", async stream => {
  const saver = new MemorySaver();
  fixture.search.mockResolvedValueOnce([{ ...hit, videoId: 60, videoTitle: "TypeScript" }]);
  const first = await runRag(env, { ...params, memory: { saver, threadId: "selected", checkpointId: null } });
  planTools = true; plan = { requested_video: "CNN LeNetの動画", query: "LeNet", video_ids: [61] };
  answerTurns = [response({ segments: [{ text: "LeNet", sourceIds: [2] }] })];
  const { result } = await execute(stream, { messages: [{ role: "user", content: "CNN LeNetの動画について" }],
    memory: { saver, threadId: "selected", checkpointId: first.checkpointId! } });
  expect(result?.answer.sources).toEqual([expect.objectContaining({ id: 2, video_id: 61 })]);
  expect(result?.answer.segments[0].sourceIds).toEqual([2]);
  const saved = await saver.get({ configurable: { thread_id: "selected" } });
  expect(saved?.channel_values.evidenceSources).toHaveLength(2);
});

it("does not use prior citations as a complete title catalog", async () => {
  const saver = new MemorySaver();
  const first = await runRag(env, { ...params, memory: { saver, threadId: "partial-sources", checkpointId: null } });
  duplicateTitles = true; pageSize = 1;
  plan = { requested_video: "CNN LeNet", query: "CNN", video_ids: null };
  await expect(runRag(env, { ...params, messages: [{ role: "user", content: "CNN LeNetの動画について" }],
    memory: { saver, threadId: "partial-sources", checkpointId: first.checkpointId! } })).rejects.toMatchObject({ name: "VideoSelectionError" });
  expect(fixture.search).toHaveBeenCalledTimes(1);
});

it("cancels catalog completion without invoking search or the answer model", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof getCourseInfo>>>();
  vi.mocked(getCourseInfo).mockImplementation(async () => { started.resolve(); return pending.promise; });
  plan = { requested_video: "CNN LeNet", query: "CNN", video_ids: null };
  const consumed = (async () => { for await (const _chunk of streamRag(env, params, controller.signal)) { /* consume */ } })();
  try {
    await started.promise;
    controller.abort();
    await expect(consumed).rejects.toThrow();
    expect(fixture.search).not.toHaveBeenCalled(); expect(order).not.toContain("answer");
  } finally { pending.resolve(null); }
});
