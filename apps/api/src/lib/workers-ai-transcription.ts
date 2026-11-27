import { Buffer } from "node:buffer";
import OpenAI, { toFile } from "openai";
import { z } from "zod";
import type { TranscriptSegment } from "../domain/media/transcription-policy";

export const WORKERS_AI_TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const MAX_TRANSCRIPTION_AUDIO_BYTES = 3_000_000;
export const transcriptionAudioRequest = z.object({
  model: z.literal(WORKERS_AI_TRANSCRIPTION_MODEL),
  audio: z.string().min(4).max(4_000_000),
  durationSeconds: z.number().finite().positive().max(300.5),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
}).strict().refine(value => {
  if (value.audio.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.audio)) return false;
  const bytes = Buffer.from(value.audio, "base64");
  return bytes.length > 0 && bytes.length <= MAX_TRANSCRIPTION_AUDIO_BYTES && bytes.toString("base64") === value.audio;
}, { message: "Invalid bounded base64 audio" });

const output = z.object({
  text: z.string().max(200_000),
  segments: z.array(z.object({
    start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(),
    text: z.string().max(8_000),
  })).max(2_000).optional(),
});

/** In-process OpenAI protocol adapter. Never calls global fetch or uses API keys. */
export function workersAiTranscriptionFetch(binding: Pick<Ai, "run">, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const combined = AbortSignal.any([request.signal, signal]);
    combined.throwIfAborted();
    if (request.method !== "POST" || request.url !== "https://workers-ai.invalid/v1/audio/transcriptions") {
      return Response.json({ error: { message: "Unsupported transcription operation" } }, { status: 400 });
    }
    // This multipart body is generated locally by our SDK, not an HTTP caller.
    const form = await request.formData();
    const file = form.get("file"), language = form.get("language");
    if (!file || typeof file === "string" || !file.size || file.size > MAX_TRANSCRIPTION_AUDIO_BYTES ||
        form.get("model") !== WORKERS_AI_TRANSCRIPTION_MODEL || form.get("response_format") !== "verbose_json" ||
        form.get("timestamp_granularities[]") !== "segment" ||
        (language !== null && (typeof language !== "string" || !/^[a-z]{2,3}$/.test(language)))) {
      return Response.json({ error: { message: "Unsupported transcription parameters" } }, { status: 400 });
    }
    const result = output.parse(await binding.run(WORKERS_AI_TRANSCRIPTION_MODEL, {
      audio: Buffer.from(await file.arrayBuffer()).toString("base64"), task: "transcribe",
      vad_filter: true, condition_on_previous_text: false,
      ...(typeof language === "string" ? { language } : {}),
    }, { signal: combined }));
    combined.throwIfAborted();
    return Response.json(result);
  };
}

/** The SDK call and timestamp policy live in TypeScript; Lambda only sends audio. */
export async function transcribeWorkersAi(
  binding: Pick<Ai, "run"> | undefined,
  input: z.infer<typeof transcriptionAudioRequest>,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  if (!binding) throw new Error("Workers AI transcription requires the AI binding");
  const combined = AbortSignal.any([AbortSignal.timeout(110_000), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  const client = new OpenAI({
    baseURL: "https://workers-ai.invalid/v1", apiKey: "binding", maxRetries: 0, timeout: 110_000,
    fetch: workersAiTranscriptionFetch(binding, combined),
  });
  const result = output.parse(await client.audio.transcriptions.create({
    model: input.model,
    file: await toFile(Buffer.from(input.audio, "base64"), "audio.mp3", { type: "audio/mpeg" }),
    response_format: "verbose_json", timestamp_granularities: ["segment"],
    ...(input.language ? { language: input.language } : {}),
  }, { signal: combined }));
  combined.throwIfAborted();
  const segments: TranscriptSegment[] = [];
  let previousStart = 0, characters = 0;
  for (const segment of result.segments ?? []) {
    if (segment.start < previousStart || segment.end < segment.start || segment.end > input.durationSeconds + 1) {
      throw new Error("Workers AI returned invalid transcription timestamps");
    }
    previousStart = segment.start;
    characters += segment.text.length;
    if (characters > 200_000) throw new Error("Workers AI transcription is too large");
    const end = Math.min(segment.end, input.durationSeconds);
    if (segment.text.trim() && segment.start < end) segments.push({ ...segment, end });
  }
  if (!segments.length && result.text.trim()) throw new Error("Workers AI must return real segment timestamps");
  return segments;
}
