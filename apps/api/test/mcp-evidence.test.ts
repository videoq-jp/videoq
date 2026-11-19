import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExternalEvidenceTools } from "../src/features/mcp/evidence-tools";
import { createEvidenceSession } from "../src/tools/session";
import { registerTools } from "../src/tools/mcp";
import { getCourseWithMembers } from "../src/repositories/chat-repository";
import { getVideoEvidence } from "../src/repositories/video-evidence-repository";
import { openSceneSearch } from "../src/repositories/vector-repository";
import { reserveAiAnswerUsage, releaseAiAnswerReservation } from "../src/repositories/quota-repository";
import { inspectVideoClip } from "../src/lib/visual-inspection";
import { startAnswerCostLedger, finishAnswerCostLedger } from "../src/lib/answer-cost-ledger";
import type { Bindings } from "../src/types/bindings";

vi.mock("../src/repositories/chat-repository", () => ({ getCourseWithMembers: vi.fn() }));
vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: vi.fn() }));
vi.mock("../src/repositories/vector-repository", () => ({ openSceneSearch: vi.fn() }));
vi.mock("../src/repositories/quota-repository", () => ({ reserveAiAnswerUsage: vi.fn(), releaseAiAnswerReservation: vi.fn() }));
vi.mock("../src/lib/visual-inspection", () => ({ inspectVideoClip: vi.fn() }));
vi.mock("../src/lib/answer-cost-ledger", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/answer-cost-ledger")>(),
  startAnswerCostLedger: vi.fn(), finishAnswerCostLedger: vi.fn(),
}));
const env = { VIDEO_VISUAL_ENABLED: "true" } as Bindings;
const scope = { ownerUserId: "owner", courseId: 3, videoIds: [42] };
const reservation = { userId: "owner", usagePeriodStart: "2026-11-20", planCode: "test", quotaSource: "test" };
const disposers: (() => Promise<unknown>)[] = [];
const search = vi.fn();
const close = vi.fn();

async function connect(external = true) {
  const server = new McpServer({ name: "test", version: "1" });
  const lifecycle = new AbortController();
  const session = createEvidenceSession(env, scope, lifecycle.signal);
  if (external) registerTools(server, createExternalEvidenceTools({ env, userId: "learner", canWrite: false }), lifecycle.signal);
  else registerTools(server, session.tools, lifecycle.signal);
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  disposers.push(async () => { lifecycle.abort(); await client.close(); await server.close(); await session.close(); });
  return client;
}
const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
const window = { video_id: 42, start_seconds: 0, end_seconds: 5, context_seconds: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 3, userId: "owner", memberVideoIds: [42] });
  vi.mocked(getVideoEvidence).mockResolvedValue({ id: 42, title: "Lesson", sourceType: "uploaded", fileKey: "private/key", transcript: "1\n00:00:00,000 --> 00:00:05,000\nEvidence", transcriptTooLarge: false });
  vi.mocked(reserveAiAnswerUsage).mockResolvedValue({ reservation });
  vi.mocked(openSceneSearch).mockResolvedValue({ search, close });
  search.mockResolvedValue([{ videoId: 42, videoTitle: "Lesson", startTime: "00:00:00", endTime: "00:00:05", content: "Evidence" }]);
  vi.mocked(inspectVideoClip).mockResolvedValue({ observations: [], sampled_timestamps: [0], sampling_interval_seconds: 5, duration_seconds: 5 });
});
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

describe("MCP evidence contract without LangGraph", () => {
  it("discovers tools, requires an external course and returns evidence without answer IDs or storage keys", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name)).toContain("search_scenes");
    expect(tools.find(t => t.name === "read_video_window")?.inputSchema.required).toContain("course_id");
    const result = await call(client, "read_video_window", { ...window, course_id: 3 });
    expect(result.structuredContent).toMatchObject({ result: { scenes: [{ videoId: 42, text: "Evidence" }] } });
    expect(JSON.stringify(result)).not.toMatch(/sourceId|private\/key|ownerUserId/);
    expect(getCourseWithMembers).toHaveBeenCalledWith(env, { courseId: 3, userId: "learner" });
    expect(getVideoEvidence).toHaveBeenCalledWith(env, { ownerUserId: "owner", videoIds: [42], courseId: 3 }, 42);
    expect(reserveAiAnswerUsage).not.toHaveBeenCalled();
  });
  it("denies inaccessible courses and out-of-scope videos before provider access", async () => {
    const client = await connect();
    vi.mocked(getCourseWithMembers).mockResolvedValueOnce(null);
    expect((await call(client, "read_video_window", { ...window, course_id: 3 })).structuredContent).toMatchObject({ result: { status: "unavailable" } });
    const denied = await call(client, "read_video_window", { ...window, video_id: 99, course_id: 3 });
    expect(JSON.stringify(denied)).toContain("Invalid video_id");
    expect(getVideoEvidence).not.toHaveBeenCalled(); expect(openSceneSearch).not.toHaveBeenCalled();
  });
  it("rejects missing scope and injected identity fields at the MCP boundary", async () => {
    const client = await connect();
    expect((await call(client, "read_video_window", window)).isError).toBe(true);
    expect((await call(client, "read_video_window", { ...window, course_id: 3, ownerUserId: "other" })).isError).toBe(true);
    expect(getCourseWithMembers).not.toHaveBeenCalled();
  });
  it("checks AI quota before paid work and refunds an unavailable operation", async () => {
    const client = await connect();
    vi.mocked(reserveAiAnswerUsage).mockResolvedValueOnce({ exceeded: true, limit: 0 });
    const args = { course_id: 3, query: "topic", video_ids: null };
    expect((await call(client, "search_scenes", args)).structuredContent).toMatchObject({ result: { status: "quota_exceeded" } });
    expect(openSceneSearch).not.toHaveBeenCalled();
    vi.mocked(inspectVideoClip).mockResolvedValueOnce({ unavailable: "No frames" });
    await call(client, "inspect_clip", { course_id: 3, video_id: 42, start_seconds: 0, end_seconds: 5, query: "graph" });
    expect(releaseAiAnswerReservation).toHaveBeenCalledWith(env, reservation);
    expect(startAnswerCostLedger).toHaveBeenCalledOnce();
    expect(finishAnswerCostLedger).toHaveBeenCalledWith(env, expect.anything(), { status: "completed", quotaConsumed: false });
  });
  it("keeps weighted limits across independent stateless server instances", async () => {
    const args = { course_id: 3, video_id: 42, start_seconds: 0, end_seconds: 5, query: "graph" };
    for (let i = 0; i < 15; i++) await call(await connect(), "focus_clip", args);
    const limited = await call(await connect(), "focus_clip", args);
    expect(limited.structuredContent).toMatchObject({ result: { status: "rate_limited" } });
    expect(inspectVideoClip).toHaveBeenCalledTimes(15);
  });
  it("reports search progress and preserves an immutable authorized scope", async () => {
    const client = await connect(false);
    const events: unknown[] = [];
    const result = await client.callTool({ name: "search_scenes", arguments: { query: "topic", video_ids: null } }, undefined, { onprogress: p => events.push(JSON.parse(p.message!)) });
    expect(events).toEqual([{ searching: "topic", searchId: 1 }, { searchCompleted: { id: 1, query: "topic", count: 1 } }]);
    expect(JSON.stringify(result)).not.toContain("sourceId");
  });
  it("records paid provider usage and consumes exactly one external AI unit", async () => {
    const client = await connect();
    vi.mocked(openSceneSearch).mockImplementationOnce(async (_env, _scope, _signal, usage) => ({
      search: async () => {
        usage!.begin("query_embedding", "embedding-test").complete({ tokens: 3 });
        return [];
      }, close,
    }));
    await call(client, "search_scenes", { course_id: 3, query: "topic", video_ids: null });
    expect(reserveAiAnswerUsage).toHaveBeenCalledExactlyOnceWith(env, "owner");
    expect(releaseAiAnswerReservation).not.toHaveBeenCalled();
    expect(finishAnswerCostLedger).toHaveBeenCalledWith(env, expect.objectContaining({ calls: [expect.objectContaining({ kind: "query_embedding", status: "completed" })] }), { status: "completed", quotaConsumed: true });
  });
  it("records execution failures as failed rather than cleanup cancellation", async () => {
    const client = await connect();
    search.mockRejectedValueOnce(new Error("private database failure"));
    const result = await call(client, "search_scenes", { course_id: 3, query: "topic", video_ids: null });
    expect(result.isError).toBe(true);
    expect(finishAnswerCostLedger).toHaveBeenCalledWith(env, expect.anything(), { status: "failed", quotaConsumed: false });
    expect(releaseAiAnswerReservation).toHaveBeenCalledWith(env, reservation);
  });
  it("shares image reservations across MCP calls and keeps answer accounting outside internal tools", async () => {
    const client = await connect(false);
    vi.mocked(inspectVideoClip).mockImplementation(async (_env, _video, start, _end, _query, _signal, options) => ({
      observations: [], sampled_timestamps: Array.from({ length: options!.maxFrames }, (_, i) => start + i),
      sampling_interval_seconds: 1, duration_seconds: 120,
    }));
    await call(client, "overview_video", { video_id: 42, query: "topic", include_visuals: true });
    await call(client, "focus_clip", { video_id: 42, start_seconds: 20, end_seconds: 36, query: "first" });
    const last = await call(client, "focus_clip", { video_id: 42, start_seconds: 40, end_seconds: 56, query: "second" });
    expect(last.structuredContent).toMatchObject({ result: { budget: { remaining_images: 0 } } });
    await call(client, "inspect_clip", { video_id: 42, start_seconds: 60, end_seconds: 70, query: "third" });
    expect(inspectVideoClip).toHaveBeenCalledTimes(3);
    expect(reserveAiAnswerUsage).not.toHaveBeenCalled();
  });
  it("copies authorized scope before callers can mutate their original video array", async () => {
    const original = { ownerUserId: "owner", videoIds: [42] };
    const session = createEvidenceSession(env, original, new AbortController().signal);
    original.videoIds.push(99);
    const tool = session.tools.find(t => t.name === "read_video_window")!;
    expect(await tool.invoke({ ...window, video_id: 99 }, { signal: new AbortController().signal })).toContain("Invalid video_id");
    expect(getVideoEvidence).not.toHaveBeenCalled();
    await session.close();
  });
  it("sanitizes infrastructure failures and returns a fatal machine-readable error", async () => {
    const client = await connect(false);
    search.mockRejectedValueOnce(new Error("private SQL and credentials"));
    const result = await call(client, "search_scenes", { query: "topic", video_ids: null });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "EXECUTION_FAILED" } } });
    expect(JSON.stringify(result)).not.toContain("private SQL");
  });
  it("forwards MCP cancellation into visual work", async () => {
    const client = await connect(false);
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    vi.mocked(inspectVideoClip).mockImplementation(async (_env, _video, _start, _end, _query, signal) => {
      started.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled.resolve(); reject(new DOMException("Cancelled", "AbortError")); }, { once: true }));
    });
    const abort = new AbortController();
    const result = client.callTool({ name: "inspect_clip", arguments: { video_id: 42, start_seconds: 0, end_seconds: 5, query: "graph" } }, undefined, { signal: abort.signal });
    const rejected = expect(result).rejects.toThrow();
    await started.promise; abort.abort(); await rejected; await cancelled.promise;
  });
});
