import { z } from "zod";
import { readMediaRange } from "../integrations/media";
import type { Bindings } from "../types/bindings";
import { focusCacheKey, MAX_FOCUS_FRAMES } from "./video-evidence";
import { readVisualManifest, visualChunkKey, type VisualVideo } from "./visual-manifest";

// Wire format written atomically by worker_python/pipeline/focus_frames.py.
const HEADER_BYTES = 12;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_PACK_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 256 * 1024;
const indexSchema = z.object({
  version: z.literal(1), video_id: z.number().int().positive().safe(),
  duration_seconds: z.number().finite().positive().max(36_000),
  sampling_interval_seconds: z.literal(1),
  frames: z.array(z.tuple([
    z.number().int().nonnegative().max(36_000_000),
    z.number().int().nonnegative().max(MAX_PACK_BYTES),
    z.number().int().positive().max(MAX_IMAGE_BYTES),
  ])).min(1).max(36_000),
}).strict();

export type FrameSelection = {
  frames: { timestamp_seconds: number; jpeg_base64: string }[];
  duration_seconds: number;
  sampling_interval_seconds: number;
} | { unavailable: string; sampling_interval_seconds?: number };

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export async function readFocusFrames(
  env: Bindings, video: VisualVideo,
  start: number, end: number, signal: AbortSignal, maxFrames = MAX_FOCUS_FRAMES,
): Promise<FrameSelection> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 16) {
    throw new Error("Focus requires a positive interval of at most 16 seconds");
  }
  const plan = await readVisualManifest(env, video, signal);
  if (plan) {
    const frames: { timestamp_seconds: number; jpeg_base64: string }[] = [];
    // A focus interval spans at most two one-minute objects. Its manifest is
    // immutable for a generation, and every individual read is ETag-pinned.
    for (let index = Math.floor(start / 60); index < plan.chunk_count && index * 60 < end; index++) {
      const result = await readFocusPack(env, video, start, end, signal, maxFrames - frames.length,
        visualChunkKey(video.fileKey, plan.run_id, index, plan.chunk_versions?.[index]),
        { start: index * 60, end: Math.min((index + 1) * 60, plan.duration_seconds), duration: plan.duration_seconds });
      if ("unavailable" in result) return result;
      frames.push(...result.frames);
    }
    return frames.length ? { frames, duration_seconds: plan.duration_seconds, sampling_interval_seconds: 1 }
      : { unavailable: "No dense frames fall in this interval; the source may have a gap or the interval may be outside the video.", sampling_interval_seconds: 1 };
  }
  if (video.visualRunId !== undefined) return { unavailable: "Visual evidence is not available for this video yet." };
  return readFocusPack(env, video, start, end, signal, maxFrames, focusCacheKey(video.fileKey));
}

async function readFocusPack(
  env: Bindings, video: VisualVideo, start: number, end: number,
  signal: AbortSignal, maxFrames: number, key: string,
  chunk?: { start: number; end: number; duration: number },
): Promise<FrameSelection> {
  const unavailable = { unavailable: "Dense focus frames are not available for this video yet. Do not substitute sparse frames as dense evidence." } as const;
  const header = await readMediaRange(env, key, 0, HEADER_BYTES, signal);
  if (!header) return unavailable;
  if (new TextDecoder().decode(header.bytes.subarray(0, 8)) !== "VQFOC001" || header.size > (chunk ? 60 * MAX_IMAGE_BYTES + 64 * 1024 : MAX_PACK_BYTES)) {
    throw new Error("Invalid focus cache header");
  }
  const length = new DataView(header.bytes.buffer, header.bytes.byteOffset, header.bytes.byteLength).getUint32(8, true);
  if (!length || length > (chunk ? 64 * 1024 : MAX_INDEX_BYTES) || HEADER_BYTES + length > header.size) throw new Error("Invalid focus index length");
  const manifest = await readMediaRange(env, key, HEADER_BYTES, length, signal, header.etag);
  if (!manifest) return unavailable;
  const schema = chunk ? indexSchema.extend({ frames: z.array(indexSchema.shape.frames.element).max(60) }) : indexSchema;
  const index = schema.parse(JSON.parse(new TextDecoder().decode(manifest.bytes)));
  const dataStart = HEADER_BYTES + length;
  let nextOffset = 0;
  let previousTime = -1000;
  if (index.video_id !== video.id || manifest.size !== header.size) throw new Error("Invalid focus cache identity");
  if (chunk && index.duration_seconds !== chunk.duration) throw new Error("Invalid visual chunk duration");
  for (const [time, offset, size] of index.frames) {
    const invalidTime = chunk
      ? time < chunk.start * 1000 || time >= chunk.end * 1000 || Math.floor(time / 1000) <= Math.floor(previousTime / 1000)
      : time - previousTime < 999;
    if (invalidTime || time > index.duration_seconds * 1000 || offset !== nextOffset) {
      throw new Error("Invalid focus frame index");
    }
    previousTime = time;
    nextOffset += size;
  }
  if (dataStart + nextOffset !== header.size) throw new Error("Focus index does not cover its image data");
  // Half-open interval avoids 17 frames for an exact [0, 16) second clip.
  const selected = index.frames.filter(([time]) => time >= start * 1000 && time < end * 1000);
  if (!selected.length) return chunk ? { frames: [], duration_seconds: index.duration_seconds, sampling_interval_seconds: 1 }
    : { unavailable: "No dense frames fall in this interval; the source may have a gap or the interval may be outside the video.", sampling_interval_seconds: 1 } as const;
  if (selected.length > Math.min(MAX_FOCUS_FRAMES, maxFrames)) return {
    unavailable: "Remaining image budget cannot cover this dense interval. Choose a shorter focus interval or answer from collected evidence.",
  } as const;
  const offset = selected[0][1];
  const last = selected[selected.length - 1];
  const images = await readMediaRange(env, key, dataStart + offset, last[1] + last[2] - offset, signal, header.etag);
  if (!images) return unavailable;
  if (images.size !== header.size) throw new Error("Focus cache changed during read");
  const frames = selected.map(([time, frameOffset, size]) => {
    const bytes = images.bytes.subarray(frameOffset - offset, frameOffset - offset + size);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw new Error("Invalid focus JPEG");
    }
    return { timestamp_seconds: time / 1000, jpeg_base64: base64(bytes) };
  });
  return { frames, duration_seconds: index.duration_seconds, sampling_interval_seconds: 1 };
}
