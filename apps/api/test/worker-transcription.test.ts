import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { workerInternalRoutes } from "../src/features/worker-internal/routes";
import { WORKERS_AI_TRANSCRIPTION_MODEL as model, transcribeWorkersAi } from "../src/lib/workers-ai-transcription";
import type { AppEnv, Bindings } from "../src/types/bindings";

const app = new Hono<AppEnv>().route("/internal/worker", workerInternalRoutes);
const secret = "worker-test-key-0123456789-abcdefghijklmnop";
const path = "/internal/worker/audio/transcriptions", origin = "https://api.example.test";
const input = { model, audio: Buffer.from("synthetic MP3").toString("base64"), durationSeconds: 300, language: "ja" };
const segments = [{ start: 0.25, end: 2, text: "確認コードは青空です。" }, { start: 240, end: 245, text: "夕焼けです。" }];
async function request(payload: Record<string, string | number | undefined>, signed = true, signedPath = path) {
  const form = new FormData();
  form.set("file", new File([Buffer.from(String(payload.audio ?? ""), "base64")], "audio.mp3", { type: "audio/mpeg" }));
  form.set("model", String(payload.model));
  form.set("duration_seconds", String(payload.durationSeconds));
  form.set("response_format", "verbose_json"); form.set("timestamp_granularities[]", "segment");
  if (payload.language !== undefined) form.set("language", String(payload.language));
  if (payload.url) form.set("url", String(payload.url));
  const multipart = new Request(origin + path, { method: "POST", body: form });
  const body = Buffer.from(await multipart.arrayBuffer()), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`videoq-worker-v1\n${timestamp}\nPOST\n${origin}\n${signedPath}\n`).update(body).digest("hex");
  return new Request(origin + path, { method: "POST", body, headers: {
    "content-type": multipart.headers.get("content-type")!,
    ...(signed ? { "x-videoq-worker-timestamp": timestamp, "x-videoq-worker-signature": signature } : {}),
  } });
}
function environment(value: unknown = { text: "青空。夕焼け。", segments }) {
  const run = vi.fn().mockResolvedValue(value);
  return { run, env: { WORKER_INTERNAL_API_SECRET: secret, AI: { run } } as unknown as Bindings };
}
describe("signed Workers AI transcription", () => {
  it("keeps source-relative VAD timestamps and selected language without provider keys", async () => {
    const { env, run } = environment();
    const response = await app.fetch(await request(input), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ task: "transcribe", duration: 300, text: segments.map(s => s.text).join(""), segments });
    expect(run).toHaveBeenCalledWith(model, { audio: input.audio, task: "transcribe", language: "ja", vad_filter: true, condition_on_previous_text: false }, { signal: expect.any(AbortSignal) });
  });
  it("rejects unsigned requests and signatures for a different operation before inference", async () => {
    const { env, run } = environment();
    expect((await app.fetch(await request(input, false), env)).status).toBe(401);
    expect((await app.fetch(await request(input, true, "/internal/worker/transcription/finish"), env)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { model: "other" }, { audio: "" },
    { durationSeconds: 301 }, { durationSeconds: 0 }, { language: "auto".repeat(10) }, { url: "https://private.invalid/audio" },
  ])("rejects invalid input before inference %j", async change => {
    const { env, run } = environment();
    expect((await app.fetch(await request({ ...input, ...change }), env)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it("verifies binary multipart bytes and rejects tampering before inference", async () => {
    const { env, run } = environment();
    const binary = { ...input, audio: Buffer.from([0, 255, 128, 13, 10, 42]).toString("base64") };
    expect((await app.fetch(await request(binary), env)).status).toBe(200);
    expect(run.mock.calls[0][1].audio).toBe(binary.audio);
    run.mockClear();
    const signed = await request(binary);
    const bytes = new Uint8Array(await signed.arrayBuffer()); bytes[bytes.length - 10] ^= 1;
    const tampered = new Request(signed.url, { method: "POST", headers: signed.headers, body: bytes });
    expect((await app.fetch(tampered, env)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects unsupported formats, duplicate fields and oversized audio files", async () => {
    const { env, run } = environment();
    for (const change of ["format", "duplicate", "file"] as const) {
      const original = await request(input), form = await original.formData();
      if (change === "format") form.set("response_format", "text");
      if (change === "duplicate") form.append("model", model);
      if (change === "file") form.set("file", new File([new Uint8Array(3_000_001)], "audio.mp3"));
      const multipart = new Request(origin + path, { method: "POST", body: form });
      const body = Buffer.from(await multipart.arrayBuffer()), timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(`videoq-worker-v1\n${timestamp}\nPOST\n${origin}\n${path}\n`).update(body).digest("hex");
      const response = await app.fetch(new Request(origin + path, { method: "POST", body, headers: {
        "content-type": multipart.headers.get("content-type")!, "x-videoq-worker-timestamp": timestamp, "x-videoq-worker-signature": signature,
      } }), env);
      expect(response.status).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });
  it("bounds the signed audio body", async () => {
    const { env, run } = environment();
    expect((await app.fetch(await request({ ...input, audio: Buffer.alloc(3_100_001).toString("base64") }), env)).status).toBe(413);
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
    const response = await app.fetch(await request(input), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "TRANSCRIPTION_UNAVAILABLE" });
  });
  it("permits real silence and leaves language detection to the model when unset", async () => {
    const { env, run } = environment({ text: "", segments: [] });
    const { language: _language, ...automatic } = input;
    const response = await app.fetch(await request(automatic), env);
    expect(await response.json()).toEqual({ task: "transcribe", duration: 300, text: "", segments: [] });
    expect(run.mock.calls[0][1]).not.toHaveProperty("language");
  });
  it("sanitizes provider failures and never falls back to another provider", async () => {
    const { env, run } = environment(); run.mockRejectedValue(new Error("PRIVATE_AUDIO_AND_TOKEN"));
    const response = await app.fetch(await request(input), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE");
    expect(run).toHaveBeenCalledOnce();
    expect((await app.fetch(await request(input), { ...env, AI: undefined })).status).toBe(503);
  });
  it("honors an already aborted inference without starting work", async () => {
    const { env, run } = environment();
    const controller = new AbortController(); controller.abort();
    await expect(transcribeWorkersAi(env.AI, input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });
});
