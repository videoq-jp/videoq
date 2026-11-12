import { iterSrtCues } from "@videoq/trpc/transcript";

/** Cue offsets, rather than timestamps, preserve overlapping and repeated cues. */
export function transcriptPage(transcript: string | null, cursor: number, limit: number) {
  const cues: { startTime: string; startSeconds: number; endSeconds: number; text: string }[] = [];
  let offset = 0;
  for (const cue of iterSrtCues(transcript ?? "")) {
    if (!cue) continue;
    if (offset++ < cursor) continue;
    if (cues.length === limit) return { cues, nextCursor: cursor + cues.length };
    cues.push({ startTime: cue.startTime, startSeconds: cue.startSeconds, endSeconds: cue.endSeconds, text: cue.text });
  }
  return { cues, nextCursor: null };
}
