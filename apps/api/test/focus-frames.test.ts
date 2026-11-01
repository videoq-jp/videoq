import { requestBodyText } from "./helpers/request-body";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFocusFrames } from "../src/lib/focus-frames";
import { inspectVideoClip } from "../src/lib/visual-inspection";
import { readMediaBytes, readMediaRange } from "../src/integrations/media";
import type { Bindings } from "../src/types/bindings";
import { focusCacheFixture } from "./helpers/focus-cache";

vi.mock("../src/integrations/media", () => ({ readMediaRange: vi.fn(), readMediaBytes: vi.fn() }));
const env = { OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://focus.test/v1" } as Bindings;
const video = { id: 42, fileKey: "private/42.mp4" };
let pack: Uint8Array;
const read = (start = 10, end = 26, maxFrames = 16) => readFocusFrames(env, video, start, end, new AbortController().signal, maxFrames);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMediaBytes).mockResolvedValue(null);
  pack = focusCacheFixture();
  vi.mocked(readMediaRange).mockImplementation(async (_env, _key, offset, length, _signal, etag) => {
    if (etag) expect(etag).toBe('"v1"');
    return { bytes: pack.slice(offset, offset + length), etag: '"v1"', size: pack.length };
  });
});
afterEach(() => vi.unstubAllGlobals());

it("reads only header, index and consecutive one-second frames in a half-open interval", async () => {
  const result = await read();
  if (!("frames" in result)) throw new Error("Expected dense frames");
  expect(result.frames.map(f => f.timestamp_seconds)).toEqual(Array.from({ length: 16 }, (_, i) => i + 10));
  expect(result.sampling_interval_seconds).toBe(1);
  expect(readMediaRange).toHaveBeenCalledTimes(3);
  expect(vi.mocked(readMediaRange).mock.calls.every(([, key]) => key === "private/42.mp4.focus-v1.bin")).toBe(true);
  expect(vi.mocked(readMediaRange).mock.calls[2][3]).toBe(16 * 6);
  expect(readMediaBytes).toHaveBeenCalledWith(env, "private/42.mp4.focus-v2.json", 32768, expect.any(AbortSignal));
});
it("preserves fractional real PTS and source gaps", async () => {
  pack = focusCacheFixture([2345, 3346, 8000, 9001]);
  expect(await read(2, 10)).toMatchObject({ frames: [
    { timestamp_seconds: 2.345 }, { timestamp_seconds: 3.346 }, { timestamp_seconds: 8 }, { timestamp_seconds: 9.001 },
  ] });
});
it("does not silently downsample when the remaining image budget is insufficient", async () => {
  expect(await read(10, 26, 8)).toHaveProperty("unavailable", expect.stringContaining("budget"));
  expect(readMediaRange).toHaveBeenCalledTimes(2);
});
it.each([[0, 17], [5, 5], [-1, 2], [0, Infinity]])("rejects invalid focus range %s..%s before storage", async (start, end) => {
  await expect(read(start, end)).rejects.toThrow("16 seconds");
  expect(readMediaRange).not.toHaveBeenCalled();
});
it("returns unavailable for an interval with no frames", async () => {
  expect(await read(40, 45)).toHaveProperty("unavailable");
  expect(readMediaRange).toHaveBeenCalledTimes(2);
});
it.each([0, 1, 2])("handles missing or concurrently replaced cache at read %s without sparse fallback", async missing => {
  let count = 0;
  vi.mocked(readMediaRange).mockImplementation(async (_env, _key, offset, length) => count++ === missing ? null
    : { bytes: pack.slice(offset, offset + length), etag: '"v1"', size: pack.length });
  expect(await read()).toHaveProperty("unavailable");
  expect(vi.mocked(readMediaBytes).mock.calls.every(([, key]) => key.endsWith(".focus-v2.json"))).toBe(true);
});
it.each(["identity", "offset", "timestamp", "duration", "density", "jpeg", "header", "index-size"])("rejects malformed %s without a model call", async kind => {
  pack = focusCacheFixture(undefined, index => {
    if (kind === "identity") index.video_id = 99;
    if (kind === "offset") index.frames[0][1] = 5;
    if (kind === "timestamp") index.frames[1][0] = 0;
    if (kind === "duration") index.duration_seconds = 2;
    if (kind === "density") index.sampling_interval_seconds = 5;
  });
  if (kind === "jpeg") pack[pack.length - 1] = 0;
  if (kind === "header") pack[0] = 0;
  if (kind === "index-size") new DataView(pack.buffer).setUint32(8, 0xffffffff, true);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(inspectVideoClip(env, video, 15, 30, "What changes?", new AbortController().signal, { mode: "focus", maxFrames: 16 })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["gpt-4o-mini", "gpt-4o-mini-2024-07-18"])("sends all sixteen high-detail images within 4o-mini request limits (%s)", async model => {
  const sent: number[] = [];
  let requests = 0;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    requests++;
    const request = JSON.parse(requestBodyText(init.body));
    const parts = request.messages[1].content as { type: string; text?: string; image_url?: { detail: string } }[];
    const images = parts.filter(p => p.type === "image_url");
    expect(images).toHaveLength(4);
    expect(images.every(p => p.image_url!.detail === "high")).toBe(true);
    expect(JSON.stringify(request)).not.toContain(video.fileKey);
    const indices = parts.flatMap(p => p.text?.startsWith("frame_index=") ? [Number(p.text.match(/frame_index=(\d+)/)![1])] : []);
    sent.push(...indices);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      observations: indices.filter(i => i === 4 || i === 16).map(i => ({ frame_index: i,
        observation: i === 4 ? "The equation changes." : "The final result appears." })),
    }) } }] });
  });
  expect(await inspectVideoClip({ ...env, LLM_MODEL: model }, video, 10, 26, "What changes?", new AbortController().signal, { mode: "focus", maxFrames: 16 }))
    .toMatchObject({ observations: [{ timestamp: 13, text: "The equation changes." }, { timestamp: 25, text: "The final result appears." }], sampling_interval_seconds: 1 });
  expect(requests).toBe(4);
  expect(sent).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
});

it("rejects observations for a real frame that was not sent in the current batch", async () => {
  const fetch = vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: {
    content: JSON.stringify({ observations: [{ frame_index: 5, observation: "Not in this batch" }] }),
  } }] }));
  vi.stubGlobal("fetch", fetch);
  await expect(inspectVideoClip({ ...env, LLM_MODEL: "gpt-4o-mini" }, video, 10, 26, "Details", new AbortController().signal, { mode: "focus", maxFrames: 16 }))
    .rejects.toThrow("Invalid visual observation frame index");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("stops later batches on cancellation without returning partial observations", async () => {
  const controller = new AbortController();
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    if (++requests === 2) controller.abort();
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ observations: [{ frame_index: 1, observation: "First batch" }] }),
    } }] });
  });
  await expect(inspectVideoClip({ ...env, LLM_MODEL: "gpt-4o-mini" }, video, 10, 26, "Details", controller.signal, { mode: "focus", maxFrames: 16 })).rejects.toThrow();
  expect(requests).toBe(2);
});
