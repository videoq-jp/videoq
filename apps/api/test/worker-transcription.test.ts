import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { workerInternalRoutes } from "../src/features/worker-internal/routes";
import { WORKERS_AI_TRANSCRIPTION_MODEL as model, transcribeWorkersAi } from "../src/lib/workers-ai-transcription";
import type { AppEnv, Bindings } from "../src/types/bindings";

const app = new Hono<AppEnv>().route("/internal/worker", workerInternalRoutes);
const secret = "worker-test-key-0123456789-abcdefghijklmnop";
const path = "/internal/worker/audio/transcribe", origin = "https://api.example.test";
const input = { model, audio: Buffer.from("synthetic MP3").toString("base64"), durationSeconds: 300, language: "ja" };
const segments = [{ start: 0.25, end: 2, text: "確認コードは青空です。" }, { start: 240, end: 245, text: "夕焼けです。" }];
function request(payload: unknown, signed = true, signedPath = path) {
  const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`videoq-worker-v1\n${timestamp}\nPOST\n${origin}\n${signedPath}\n${body}`).digest("hex");
  return new Request(origin + path, { method: "POST", body, headers: signed ? {
    "x-videoq-worker-timestamp": timestamp, "x-videoq-worker-signature": signature,
  } : {} });
}
function environment(value: unknown = { text: "青空。夕焼け。", segments }) {
  const run = vi.fn().mockResolvedValue(value);
  return { run, env: { WORKER_INTERNAL_API_SECRET: secret, AI: { run } } as unknown as Bindings };
}
describe("signed Workers AI transcription", () => {
  it("keeps source-relative VAD timestamps and selected language without provider keys", async () => {
    const { env, run } = environment();
    const response = await app.fetch(request(input), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ model, segments });
    expect(run).toHaveBeenCalledWith(model, { audio: input.audio, task: "transcribe", language: "ja", vad_filter: true, condition_on_previous_text: false }, { signal: expect.any(AbortSignal) });
  });
  it("rejects unsigned requests and signatures for a different operation before inference", async () => {
    const { env, run } = environment();
    expect((await app.fetch(request(input, false), env)).status).toBe(401);
    expect((await app.fetch(request(input, true, "/internal/worker/transcription/finish"), env)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { model: "other" }, { audio: "" }, { audio: "not base64!" }, { audio: "YR==" },
    { durationSeconds: 301 }, { durationSeconds: 0 }, { language: "auto".repeat(10) }, { url: "https://private.invalid/audio" },
  ])("rejects invalid input before inference %j", async change => {
    const { env, run } = environment();
    expect((await app.fetch(request({ ...input, ...change }), env)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it("bounds the signed audio body", async () => {
    const { env, run } = environment();
    expect((await app.fetch(request({ ...input, audio: "A".repeat(4_100_001) }), env)).status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { text: "No timestamps" }, { text: "word", segments: [{ start: -1, end: 1, text: "word" }] },
    { text: "word", segments: [{ start: 2, end: 1, text: "word" }] },
    { text: "word", segments: [{ start: 0, end: 302, text: "word" }] },
    { text: "word", segments: [{ start: 2, end: 3, text: "word" }, { start: 1, end: 2, text: "word" }] },
    { text: "word", segments: [{ start: 0, end: Number.NaN, text: "word" }] },
  ])("rejects malformed model output without partial success %j", async output => {
    const { env } = environment(output);
    const response = await app.fetch(request(input), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "TRANSCRIPTION_UNAVAILABLE" });
  });
  it("permits real silence and leaves language detection to the model when unset", async () => {
    const { env, run } = environment({ text: "", segments: [] });
    const { language: _language, ...automatic } = input;
    const response = await app.fetch(request(automatic), env);
    expect(await response.json()).toEqual({ model, segments: [] });
    expect(run.mock.calls[0][1]).not.toHaveProperty("language");
  });
  it("sanitizes provider failures and never falls back to another provider", async () => {
    const { env, run } = environment(); run.mockRejectedValue(new Error("PRIVATE_AUDIO_AND_TOKEN"));
    const response = await app.fetch(request(input), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE");
    expect(run).toHaveBeenCalledOnce();
    expect((await app.fetch(request(input), { ...env, AI: undefined })).status).toBe(503);
  });
  it("honors an already aborted inference without starting work", async () => {
    const { env, run } = environment();
    const controller = new AbortController(); controller.abort();
    await expect(transcribeWorkersAi(env.AI, input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });
});
