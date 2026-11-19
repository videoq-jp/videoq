import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcriptWindow, transcriptTimeline, formatEvidenceTime, sampleByTime } from "../src/lib/video-evidence";
import { createVideoEvidenceTools } from "../src/tools/video-evidence";
import { connectTestTools } from "./helpers/mcp-tools";
import { getVideoEvidence } from "../src/repositories/video-evidence-repository";
import { inspectVideoClip } from "../src/lib/visual-inspection";
import type { SceneHit } from "../src/repositories/vector-repository";
import type { Bindings } from "../src/types/bindings";

vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: vi.fn() }));
vi.mock("../src/lib/visual-inspection", () => ({ inspectVideoClip: vi.fn() }));
const env = { VIDEO_VISUAL_ENABLED: "true" } as Bindings;
const videoEvidenceTools = (bindings: Bindings, evidenceScope: typeof scope, addSource: (hit: SceneHit) => number, signal: AbortSignal, question?: string) =>
  connectTestTools(createVideoEvidenceTools(bindings, evidenceScope, question), signal, { addSource, collectContext: () => {} });
const scope = { ownerUserId: "owner", videoIds: [42] };
const transcript = [
  "1\n00:00:00,000 --> 00:00:05,000\nBefore",
  "2\n00:01:38,000 --> 00:01:43,000\nOverlaps start",
  "3\n00:01:44,000 --> 00:01:45,000\nInside",
  "4\n00:03:20,000 --> 00:03:25,000\nAfter",
].join("\n\n");
const video = { id: 42, title: "Lecture", transcript, fileKey: "private/video.mp4", sourceType: "uploaded", transcriptTooLarge: false };
const windowArgs = { video_id: 42, start_seconds: 100, end_seconds: 110, context_seconds: 0 };
const clipArgs = { video_id: 42, start_seconds: 100, end_seconds: 110, query: "What does the graph show?" };
beforeEach(() => {
  vi.mocked(getVideoEvidence).mockReset().mockResolvedValue(video);
  vi.mocked(inspectVideoClip).mockReset().mockResolvedValue({
    observations: [{ timestamp: 104.125, text: "The red line rises." }],
    sampled_timestamps: [104.125], sampling_interval_seconds: 5, duration_seconds: 210,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("subtitle windows", () => {
  it("uses interval intersection and retains true cue boundaries", () => {
    const result = transcriptWindow(video, 100, 110, 0);
    expect(result.scenes.map(s => s.content)).toEqual(["Overlaps start", "Inside"]);
    expect(result.scenes[0].startTime).toBe("00:01:38,000");
    expect(result.truncated).toBe(false);
    expect(transcriptWindow(video, 5, 6, 10).start).toBe(0);
  });
  it("makes output truncation explicit and skips invalid cues", () => {
    const large = { ...video, transcript: `invalid\n\n1\n00:00:00,000 --> 00:00:01,000\n${"x".repeat(13_000)}` };
    const result = transcriptWindow(large, 0, 2, 0);
    expect(result.truncated).toBe(true);
    expect(result.scenes[0].content).toHaveLength(12_000);
  });
  it("retains milliseconds for frame citations", () => {
    expect(formatEvidenceTime(3661.125)).toBe("01:01:01,125");
  });
});

describe("authorized evidence tools", () => {
  it("preserves the original question and returns actual numeric observation times", async () => {
    const question = "How many circles are in each row?";
    const tools = (await videoEvidenceTools(env, scope, () => 1, new AbortController().signal, question));
    const result = JSON.parse(String(await tools.find(t => t.name === "inspect_clip")!.invoke(clipArgs)));
    expect(inspectVideoClip).toHaveBeenCalledWith(env, { id: 42, fileKey: video.fileKey }, 100, 110,
      `Original user question: ${question}\nSpecific inspection task: ${clipArgs.query}`, expect.any(AbortSignal), { mode: "inspect", maxFrames: 8 });
    expect(result.observations[0]).toMatchObject({ timestamp_seconds: 104.125, startTime: "00:01:44,125" });
  });
  it("exposes visuals only when configured", async () => {
    const tools = (await videoEvidenceTools({ ...env, VIDEO_VISUAL_ENABLED: "false" }, scope, () => 1, new AbortController().signal));
    expect(tools.map(t => t.name)).toEqual(["read_video_window", "overview_video", "skim_video"]);
  });
  it.each(["read_video_window", "inspect_clip", "overview_video", "skim_video", "focus_clip"])("%s refuses other videos before DB/storage/model access", async name => {
    const tools = (await videoEvidenceTools(env, scope, () => 1, new AbortController().signal));
    const args = name === "overview_video" ? { video_id: 42, query: "graph", include_visuals: true }
      : name === "skim_video" ? { ...clipArgs, include_visuals: true }
      : name === "inspect_clip" || name === "focus_clip" ? clipArgs : windowArgs;
    const result = await tools.find(t => t.name === name)!.invoke({ ...args, video_id: 99 });
    expect(result).toContain("Invalid video_id");
    expect(getVideoEvidence).not.toHaveBeenCalled();
    expect(inspectVideoClip).not.toHaveBeenCalled();
  });
  it("reads surrounding subtitles and registers sources without leaking media keys", async () => {
    const sources: SceneHit[] = [];
    const [read] = (await videoEvidenceTools(env, scope, hit => sources.push(hit), new AbortController().signal));
    const result = String(await read.invoke(windowArgs));
    expect(JSON.parse(result).scenes.map((s: { sourceId: number }) => s.sourceId)).toEqual([1, 2]);
    expect(result).not.toContain(video.fileKey);
    expect(sources).toHaveLength(2);
    expect(getVideoEvidence).toHaveBeenCalledWith(env, scope, 42);
  });
  it("rejects reversed/oversized intervals and bounds repeated calls", async () => {
    const [read] = (await videoEvidenceTools(env, scope, () => 1, new AbortController().signal));
    expect(await read.invoke({ ...windowArgs, end_seconds: 99 })).toContain("positive interval");
    expect(await read.invoke({ ...windowArgs, end_seconds: 281 })).toContain("180 seconds");
    for (let i = 0; i < 3; i++) await read.invoke(windowArgs);
    expect(await read.invoke(windowArgs)).toContain("limit reached");
    expect(getVideoEvidence).toHaveBeenCalledTimes(3);
  });
  it("does not call vision for YouTube imports or missing videos", async () => {
    const [, inspect] = (await videoEvidenceTools(env, scope, () => 1, new AbortController().signal));
    vi.mocked(getVideoEvidence).mockResolvedValueOnce({ ...video, sourceType: "youtube" });
    expect(await inspect.invoke(clipArgs)).toContain("YouTube");
    vi.mocked(getVideoEvidence).mockResolvedValueOnce(null);
    expect(await inspect.invoke({ ...clipArgs, query: "Other question" })).toContain("unavailable");
    expect(inspectVideoClip).not.toHaveBeenCalled();
  });
  it("uses actual frame timestamps and enforces the two-call budget", async () => {
    const sources: SceneHit[] = [];
    const [, inspect] = (await videoEvidenceTools(env, scope, hit => sources.push(hit), new AbortController().signal));
    const result = String(await inspect.invoke(clipArgs));
    expect(JSON.parse(result).observations[0]).toMatchObject({ sourceId: 1, evidenceType: "visual", startTime: "00:01:44,125" });
    expect(sources[0].endTime).toBe("00:01:44,125");
    expect(result).not.toContain(video.fileKey);
    expect(await inspect.invoke(clipArgs)).toContain("already inspected");
    await inspect.invoke({ ...clipArgs, query: "Another question" });
    expect(await inspect.invoke({ ...clipArgs, query: "Third question" })).toContain("limit reached");
    expect(inspectVideoClip).toHaveBeenCalledTimes(2);
  });
  it("stops before accessing private data after cancellation", async () => {
    const controller = new AbortController();
    const [read] = (await videoEvidenceTools(env, scope, () => 1, controller.signal));
    controller.abort();
    await expect(read.invoke(windowArgs)).rejects.toThrow();
    expect(getVideoEvidence).not.toHaveBeenCalled();
  });
});

describe("adaptive video navigation", () => {
  const makeTools = async (bindings = env) => (await videoEvidenceTools(bindings, scope, () => 1, new AbortController().signal));
  const overviewArgs = { video_id: 42, query: "Find the diagram", include_visuals: true };
  const skimArgs = { ...clipArgs, include_visuals: true };
  const get = (tools: Awaited<ReturnType<typeof makeTools>>, name: string) => tools.find(t => t.name === name)!;

  it("leaves and reports enough budget after an overview to compare two dense candidates", async () => {
    vi.mocked(inspectVideoClip).mockImplementation(async (_env, _video, start, _end, _query, _signal, options) => ({
      observations: [{ timestamp: start, text: "Visible state" }],
      sampled_timestamps: Array.from({ length: options!.maxFrames }, (_, i) => start + i),
      sampling_interval_seconds: 1, duration_seconds: 300,
    }));
    const tools = (await makeTools());
    const overview = JSON.parse(String(await get(tools, "overview_video").invoke(overviewArgs)));
    expect(overview.visuals.status).toBe("observed");
    expect(overview.budget).toMatchObject({ remaining_images: 32, remaining_visual_calls: 3, remaining_focus_calls: 2 });
    const first = JSON.parse(String(await get(tools, "focus_clip").invoke({ ...clipArgs, start_seconds: 60, end_seconds: 76 })));
    expect(first.budget).toMatchObject({ remaining_images: 16, remaining_focus_calls: 1 });
    const second = JSON.parse(String(await get(tools, "focus_clip").invoke({ ...clipArgs, start_seconds: 180, end_seconds: 196 })));
    expect(second.status).toBe("observed");
    expect(second.budget).toMatchObject({ remaining_images: 0, remaining_focus_calls: 0 });
    expect(inspectVideoClip).toHaveBeenCalledTimes(3);
  });

  it("distinguishes missing caches, empty observations and skipped visuals, refunding unused images", async () => {
    const tools = (await makeTools());
    vi.mocked(inspectVideoClip).mockResolvedValueOnce({ unavailable: "Dense cache missing" });
    const missing = JSON.parse(String(await get(tools, "focus_clip").invoke(clipArgs)));
    expect(missing).toMatchObject({ status: "unavailable", budget: { remaining_images: 48, remaining_visual_calls: 3, remaining_focus_calls: 1 } });
    vi.mocked(inspectVideoClip).mockResolvedValueOnce({ observations: [], sampled_timestamps: [104], sampling_interval_seconds: 5, duration_seconds: 210 });
    const empty = JSON.parse(String(await get(tools, "overview_video").invoke(overviewArgs)));
    expect(empty.visuals.status).toBe("no_observations");
    expect(empty.budget.remaining_images).toBe(47);
    const skipped = JSON.parse(String(await get(tools, "skim_video").invoke({ ...skimArgs, include_visuals: false })));
    expect(skipped.visuals.status).toBe("skipped");
    expect(skipped.budget).toEqual(empty.budget);
  });

  it("exposes coarse transcript timing without inventing more precise cue boundaries", async () => {
    vi.mocked(getVideoEvidence).mockResolvedValue({ ...video, transcript: "1\n00:00:00,000 --> 00:04:56,000\nLong legacy scene" });
    const tools = (await makeTools());
    const result = JSON.parse(String(await get(tools, "read_video_window").invoke(windowArgs)));
    expect(result.scenes[0]).toMatchObject({ startTime: "00:00:00,000", endTime: "00:04:56,000", transcript_quality: { flags: ["coarse_timing"] } });
  });

  it("samples the whole subtitle timeline, preserving late evidence and bounding excerpts", () => {
    const cues = Array.from({ length: 50 }, (_, i) => `${i + 1}\n${formatEvidenceTime(i * 100)} --> ${formatEvidenceTime(i * 100 + 10)}\n${i === 49 ? "z".repeat(1500) : `Topic ${i}`}`);
    const result = transcriptTimeline({ ...video, transcript: cues.reverse().join("\n\n") });
    expect(result.scenes).toHaveLength(12);
    expect(result.scenes[0].content).toBe("Topic 0");
    expect(result.scenes.at(-1)!.content).toBe("z".repeat(1000));
    expect(result).toMatchObject({ matched_cues: 50, sampled: true, truncated: true, last_subtitle_end_seconds: 4910 });
    expect(transcriptTimeline(video, 100, 110).scenes.map(s => s.content)).toEqual(["Overlaps start", "Inside"]);
    expect(transcriptTimeline({ ...video, transcript: "invalid" }).scenes).toEqual([]);
  });
  it("samples by time rather than cue density, without duplicate evidence across gaps", () => {
    const times = [...Array.from({ length: 50 }, (_, i) => i), 200, 500, 1000];
    expect(sampleByTime(times, t => t, 4)).toEqual([0, 200, 500, 1000]);
    const sparse = sampleByTime([0, 1, 2, 3, 4, 1000], t => t, 5);
    expect(new Set(sparse).size).toBe(sparse.length);
    expect(sparse.at(-1)).toBe(1000);
  });
  it("offers subtitle navigation with visuals disabled, without storage or model calls", async () => {
    const tools = (await makeTools({ ...env, VIDEO_VISUAL_ENABLED: "false" }));
    const result = JSON.parse(String(await get(tools, "overview_video").invoke(overviewArgs)));
    expect(result.subtitles.scenes).toHaveLength(4);
    expect(result.visuals.unavailable).toContain("disabled");
    expect(result).not.toHaveProperty("duration_seconds");
    expect(inspectVideoClip).not.toHaveBeenCalled();
  });
  it("can scan without subtitle clues and lets the agent choose whether to view images", async () => {
    vi.mocked(getVideoEvidence).mockResolvedValue({ ...video, transcript: "" });
    const tools = (await makeTools());
    const overview = JSON.parse(String(await get(tools, "overview_video").invoke(overviewArgs)));
    expect(overview.subtitles.scenes).toEqual([]);
    expect(overview.visuals.observations[0].evidenceType).toBe("visual");
    expect(inspectVideoClip).toHaveBeenCalledWith(env, { id: 42, fileKey: video.fileKey }, 0, Infinity, overviewArgs.query, expect.any(AbortSignal), { mode: "overview", maxFrames: 16 });
    await get(tools, "skim_video").invoke({ ...skimArgs, include_visuals: false });
    expect(inspectVideoClip).toHaveBeenCalledTimes(1);
  });
  it("keeps subtitle evidence when images are missing, unsupported or the transcript is oversized", async () => {
    const tools = (await makeTools());
    vi.mocked(inspectVideoClip).mockResolvedValueOnce({ unavailable: "No cache" });
    const missing = JSON.parse(String(await get(tools, "overview_video").invoke(overviewArgs)));
    expect(missing.subtitles.scenes).toHaveLength(4);
    expect(missing.visuals.unavailable).toBe("No cache");
    vi.mocked(getVideoEvidence).mockResolvedValueOnce({ ...video, sourceType: "youtube" });
    const youtube = JSON.parse(String(await get(tools, "skim_video").invoke(skimArgs)));
    expect(youtube.visuals.unavailable).toContain("YouTube");
    expect(youtube.subtitles.scenes).toHaveLength(2);
    vi.mocked(getVideoEvidence).mockResolvedValueOnce({ ...video, transcriptTooLarge: true, transcript: null });
    const large = JSON.parse(String(await get(tools, "skim_video").invoke({ ...skimArgs, query: "Other" })));
    expect(large.subtitles.unavailable).toContain("too large");
    expect(large.visuals.observations).toHaveLength(1);
  });
  it("bounds coarse intervals and repeated overview/skim requests", async () => {
    const tools = (await makeTools());
    const overview = get(tools, "overview_video");
    const skim = get(tools, "skim_video");
    expect(await skim.invoke({ ...skimArgs, start_seconds: 0, end_seconds: 901 })).toContain("900 seconds");
    expect(await skim.invoke({ ...skimArgs, end_seconds: 90 })).toContain("positive interval");
    await overview.invoke(overviewArgs);
    expect(await overview.invoke(overviewArgs)).toContain("already requested");
    await overview.invoke({ ...overviewArgs, query: "Other" });
    expect(await overview.invoke({ ...overviewArgs, query: "Third" })).toContain("limit reached");
    await skim.invoke({ ...skimArgs, end_seconds: 900, include_visuals: false });
    await skim.invoke({ ...skimArgs, include_visuals: false });
    expect(await skim.invoke(skimArgs)).toContain("limit reached");
    expect(getVideoEvidence).toHaveBeenCalledTimes(4);
  });
  it("shares a four-call budget across overview, skim, detail and dense focus", async () => {
    const tools = (await makeTools());
    await get(tools, "overview_video").invoke(overviewArgs);
    await get(tools, "skim_video").invoke(skimArgs);
    await get(tools, "inspect_clip").invoke(clipArgs);
    await get(tools, "focus_clip").invoke(clipArgs);
    const limited = JSON.parse(String(await get(tools, "skim_video").invoke({ ...skimArgs, query: "Other" })));
    expect(limited.visuals.unavailable).toContain("limit reached");
    expect(limited.subtitles.scenes).toHaveLength(2);
    expect(inspectVideoClip).toHaveBeenCalledTimes(4);
  });
  it("reserves the 48-image budget and serializes parallel viewing requests", async () => {
    const first = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let running = 0;
    let peak = 0;
    vi.mocked(inspectVideoClip).mockImplementation(async (_env, _video, _start, _end, _query, _signal, options) => {
      peak = Math.max(peak, ++running);
      started.resolve();
      await first.promise;
      running--;
      return { observations: [], sampled_timestamps: Array.from({ length: options!.maxFrames }, (_, i) => i * 5), sampling_interval_seconds: 5, duration_seconds: 210 };
    });
    const tools = (await makeTools());
    const a = get(tools, "overview_video").invoke(overviewArgs);
    await started.promise;
    const b = get(tools, "overview_video").invoke({ ...overviewArgs, query: "Other" });
    const c = get(tools, "focus_clip").invoke(clipArgs);
    const d = get(tools, "inspect_clip").invoke(clipArgs);
    first.resolve();
    const results = await Promise.all([a, b, c, d]);
    expect(String(results[3])).toContain("limit reached");
    expect(inspectVideoClip).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });
  it("enables image tools by default and allows explicit opt-out", async () => {
    expect(get((await makeTools({} as Bindings)), "focus_clip").name).toBe("focus_clip");
    expect(get((await makeTools({} as Bindings)), "inspect_clip").name).toBe("inspect_clip");
    expect((await makeTools({ ...env, VIDEO_VISUAL_ENABLED: "false" })).map(t => t.name)).not.toContain("focus_clip");
  });
  it("bounds focus to short clips, preserves timestamps, and refuses YouTube images", async () => {
    const tools = (await makeTools());
    const focus = get(tools, "focus_clip");
    expect(await focus.invoke({ ...clipArgs, end_seconds: 117 })).toContain("16 seconds");
    const result = JSON.parse(String(await focus.invoke(clipArgs)));
    expect(result.observations[0]).toMatchObject({ evidenceType: "visual", startTime: "00:01:44,125" });
    expect(inspectVideoClip).toHaveBeenCalledWith(env, { id: 42, fileKey: video.fileKey }, 100, 110, clipArgs.query,
      expect.any(AbortSignal), { mode: "focus", maxFrames: 16 });
    expect(await focus.invoke(clipArgs)).toContain("already inspected");
    vi.mocked(getVideoEvidence).mockResolvedValueOnce({ ...video, sourceType: "youtube" });
    expect(await focus.invoke({ ...clipArgs, query: "Other" })).toContain("YouTube");
    expect(inspectVideoClip).toHaveBeenCalledTimes(1);
    expect(await focus.invoke({ ...clipArgs, query: "Third" })).toContain("limit reached");
  });
  it("cancels navigation before accessing evidence", async () => {
    const controller = new AbortController();
    const tools = (await videoEvidenceTools(env, scope, () => 1, controller.signal));
    controller.abort();
    await expect(get(tools, "overview_video").invoke(overviewArgs)).rejects.toThrow();
    await expect(get(tools, "skim_video").invoke(skimArgs)).rejects.toThrow();
    expect(getVideoEvidence).not.toHaveBeenCalled();
  });
});
