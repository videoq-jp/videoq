import { iterSrtCues } from "@videoq/domain/transcript";
import type { SceneHit } from "./evidence";

export const MAX_WINDOW_READS = 3;
export const MAX_OVERVIEWS = 2;
export const MAX_SKIMS = 2;
export const MAX_CLIP_INSPECTIONS = 2;
export const MAX_FOCUS_CALLS = 2;
export const MAX_FOCUS_FRAMES = 16;
export const MAX_FOCUS_INTERVAL_SECONDS = 16;
export const MAX_CLIP_FRAMES = 8;
export const MAX_OVERVIEW_FRAMES = 16;
export const MAX_VISUAL_CALLS = 4;
export const MAX_VISUAL_FRAMES = 48;

/** Uploaded-video viewing is on by default; explicit false opts out. */
export const videoVisualEnabled = (value: string | undefined) =>
  value === undefined || ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());

/** Select real samples nearest evenly spaced times. Input must be time-sorted. */
export function sampleByTime<T>(values: readonly T[], time: (value: T) => number, limit: number): T[] {
  if (values.length <= limit) return [...values];
  if (limit <= 0) return [];
  if (limit === 1) return [values[Math.floor(values.length / 2)]];
  const first = time(values[0]);
  const last = time(values[values.length - 1]);
  const selected = new Set<number>();
  for (let i = 0; i < limit; i++) {
    const target = first + (last - first) * i / (limit - 1);
    let low = 0;
    let high = values.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (time(values[mid]) < target) low = mid + 1;
      else high = mid;
    }
    if (low > 0 && target - time(values[low - 1]) < time(values[low]) - target) low--;
    selected.add(low);
  }
  // Equal timestamps and large gaps can produce fewer samples than the limit.
  return [...selected].sort((a, b) => a - b).map(i => values[i]);
}

export function selectClipFrames<T extends { timestamp_seconds: number }>(frames: readonly T[], start: number, end: number, limit = MAX_CLIP_FRAMES): T[] {
  return sampleByTime(frames.filter(frame => frame.timestamp_seconds >= start && frame.timestamp_seconds <= end), frame => frame.timestamp_seconds, limit);
}

export function assertFocusInterval(start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > MAX_FOCUS_INTERVAL_SECONDS) {
    throw new Error(`Focus requires a positive interval of at most ${MAX_FOCUS_INTERVAL_SECONDS} seconds`);
  }
}

/** Keep every dense sample in the half-open interval; never silently turn it into sparse evidence. */
export function selectDenseFramePlan<T>(frames: readonly T[], time: (frame: T) => number, start: number, end: number, maxFrames: number): { frames: T[] } | { unavailable: string } {
  const selected = frames.filter(frame => time(frame) >= start && time(frame) < end);
  if (selected.length && selected.length > Math.min(MAX_FOCUS_FRAMES, maxFrames)) {
    return { unavailable: 'Remaining image budget cannot cover this dense interval. Choose a shorter focus interval or answer from collected evidence.' } as const;
  }
  return { frames: selected };
}

/** Broad navigation must include later cues instead of truncating the beginning. */
export function transcriptTimeline(
  video: { id: number; title: string; transcript: string | null },
  start = 0, end = Infinity,
) {
  const cues = [...iterSrtCues(video.transcript ?? "")].filter(cue => cue !== null)
    .filter(cue => cue.startSeconds <= end && cue.endSeconds >= start);
  cues.sort((a, b) => a.startSeconds - b.startSeconds);
  const selected = sampleByTime(cues, cue => cue.startSeconds, 12);
  return {
    matched_cues: cues.length,
    sampled: selected.length < cues.length,
    truncated: selected.some(cue => cue.text.length > 1000),
    // Subtitle end is not a reliable video duration (there may be silent footage).
    last_subtitle_end_seconds: cues.length ? cues.reduce((last, cue) => Math.max(last, cue.endSeconds), 0) : null,
    scenes: selected.map(cue => ({
      videoId: video.id, videoTitle: video.title, content: cue.text.slice(0, 1000),
      startTime: cue.startTime, endTime: cue.endTime,
    })),
  };
}

export function formatEvidenceTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export function transcriptWindow(
  video: { id: number; title: string; transcript: string | null },
  start: number, end: number, contextSeconds: number,
): { scenes: SceneHit[]; truncated: boolean; start: number; end: number } {
  const from = Math.max(0, start - contextSeconds);
  const to = end + contextSeconds;
  const scenes: SceneHit[] = [];
  let chars = 0;
  let truncated = false;
  for (const cue of iterSrtCues(video.transcript ?? "")) {
    // Both conditions matter: OR includes every valid subtitle in the video.
    if (!cue || cue.startSeconds > to || cue.endSeconds < from) continue;
    if (scenes.length >= 40 || chars >= 12_000) { truncated = true; break; }
    const content = cue.text.slice(0, 12_000 - chars);
    truncated ||= content.length !== cue.text.length;
    chars += content.length;
    scenes.push({
      videoId: video.id, videoTitle: video.title, content,
      startTime: cue.startTime, endTime: cue.endTime,
    });
  }
  return { scenes, truncated, start: from, end: to };
}
