import { requestBodyText } from "./helpers/request-body";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectVideoClip, selectClipFrames } from "../src/lib/visual-inspection";
import { readMediaBytes } from "../src/integrations/media";
import type { Bindings } from "../src/types/bindings";

vi.mock("../src/integrations/media", () => ({ readMediaBytes: vi.fn() }));
vi.mock("../src/lib/visual-manifest", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/visual-manifest")>(),
  readVisualManifest: vi.fn(async () => null),
}));
const env = { OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://vision.test/v1", LLM_MODEL: "shared-model" } as Bindings;
const frames = Array.from({ length: 20 }, (_, i) => ({ timestamp_seconds: i * 5, jpeg_base64: "/9j/2Q==" }));
const cache = { version: 1, video_id: 42, duration_seconds: 100, sampling_interval_seconds: 5, frames };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const inspect = (signal = new AbortController().signal) => inspectVideoClip(env, { id: 42, fileKey: "private/video.mp4" }, 10, 70, "Read the equation", signal);
beforeEach(() => vi.mocked(readMediaBytes).mockReset().mockResolvedValue(encode(cache)));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("selects at most eight in-window frames across the interval", () => {
  const selected = selectClipFrames(frames, 10, 70);
  expect(selected).toHaveLength(8);
  expect(selected[0].timestamp_seconds).toBe(10);
  expect(selected.at(-1)!.timestamp_seconds).toBe(70);
  expect(new Set(selected.map(f => f.timestamp_seconds)).size).toBe(8);
  expect(selectClipFrames(frames, 11, 14)).toEqual([]);
});
it("sends only selected images, resolves citations by server frame index, and reports usage", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ observations: [{ frame_index: 1, observation: "x = 2" }] }) } }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
  }));
  const result = await inspect();
  expect(result).toMatchObject({ observations: [{ timestamp: 10, text: "x = 2" }] });
  expect(JSON.stringify(requests[0])).not.toContain("private/video.mp4");
  expect(JSON.stringify(requests[0]).match(/data:image\/jpeg/g)).toHaveLength(8);
  expect(requests[0].model).toBe(env.LLM_MODEL);
  expect(requests[0].stream).toBeUndefined();
});
it("uses the dedicated LLM credentials and endpoint for image inspection", async () => {
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer router-key");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"observations":[]}' } }] });
  });
  await inspectVideoClip({ ...env, LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_API_KEY: "router-key" },
    { id: 42, fileKey: "private/video.mp4" }, 10, 70, "Read", new AbortController().signal);
});
it("uses the shared OpenRouter key and Luna model for images", async () => {
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer shared-router-key");
    expect(JSON.parse(requestBodyText(init.body))).toMatchObject({ model: "openai/gpt-6-luna", reasoning_effort: "none", max_tokens: 2048 });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"observations":[]}' } }] });
  });
  await inspectVideoClip({ OPENROUTER_API_KEY: "shared-router-key" } as Bindings,
    { id: 42, fileKey: "private/video.mp4" }, 10, 70, "Read", new AbortController().signal);
});
it.each([{}, { LLM_MODEL: "" }, { LLM_MODEL: "gpt-6-luna" }])("uses Luna without reasoning and keeps images in one request: %j", async models => {
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(requestBodyText(init.body));
    expect(body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none", max_completion_tokens: 2048 });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.response_format.json_schema.schema.properties.observations.items.properties.frame_index.enum).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(JSON.stringify(body.messages)).not.toContain("timestamp_seconds");
    expect(JSON.stringify(body).match(/data:image\/jpeg/g)).toHaveLength(8);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ observations: [{ frame_index: 8, observation: "Final frame" }] }) } }] });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await inspectVideoClip({ OPENAI_API_KEY: "test", ...models } as Bindings,
    { id: 42, fileKey: "private/video.mp4" }, 10, 70, "Read the equation", new AbortController().signal);
  expect(result).toMatchObject({ observations: [{ timestamp: 70, text: "Final frame" }] });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(["overview", "skim", "inspect"] as const)("uses bounded frames and image detail appropriate to %s", async mode => {
  let request: { messages: { content: unknown }[] } | undefined;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    request = JSON.parse(requestBodyText(init.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      observations: [{ frame_index: mode === "overview" ? 16 : 8, observation: "Late diagram" }],
    }) } }] });
  });
  const result = await inspectVideoClip(env, { id: 42, fileKey: "private/video.mp4" }, 0, Infinity, "Locate diagram", new AbortController().signal, { mode, maxFrames: 16 });
  const parts = request!.messages[1].content as { type: string; image_url?: { detail: string } }[];
  const images = parts.filter(part => part.type === "image_url");
  expect(images).toHaveLength(mode === "overview" ? 16 : 8);
  expect(images.every(part => part.image_url?.detail === (mode === "inspect" ? "high" : "low"))).toBe(true);
  expect(result).toMatchObject({ observations: [{ timestamp: 95, text: "Late diagram" }], duration_seconds: 100 });
});
it.each(["missing", "mismatched", "empty-window", "malformed"])("handles %s cache without calling the model", async kind => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  if (kind === "missing") vi.mocked(readMediaBytes).mockResolvedValue(null);
  if (kind === "mismatched") vi.mocked(readMediaBytes).mockResolvedValue(encode({ ...cache, video_id: 99 }));
  if (kind === "empty-window") vi.mocked(readMediaBytes).mockResolvedValue(encode({ ...cache, frames: [frames[0]] }));
  if (kind === "malformed") vi.mocked(readMediaBytes).mockResolvedValue(encode({ ...cache, frames: [{ timestamp_seconds: 10, jpeg_base64: "https://untrusted/image" }] }));
  if (kind === "missing" || kind === "empty-window") expect(await inspect()).toHaveProperty("unavailable");
  else await expect(inspect()).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it.each(["index", "duplicate", "length", "refusal"])("rejects invalid vision output: %s", async kind => {
  vi.stubGlobal("fetch", async () => Response.json({ choices: [{
    finish_reason: kind === "length" ? "length" : "stop",
    message: { refusal: kind === "refusal" ? "refused" : null, content: JSON.stringify({ observations:
      kind === "duplicate" ? [{ frame_index: 1, observation: "a" }, { frame_index: 1, observation: "b" }]
        : [{ frame_index: kind === "index" ? 9 : 1, observation: "a" }],
    }) },
  }] }));
  await expect(inspect()).rejects.toThrow();
});
it("cancels an in-flight model request", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason instanceof Error ? init.signal!.reason : new Error("Aborted")), { once: true });
    started.resolve();
  }));
  const pending = inspect(controller.signal);
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toThrow();
});
