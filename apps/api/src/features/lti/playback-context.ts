import { iterSrtCues } from "@videoq/trpc/transcript";

/** Locate the actual cue at the playhead; do not invent a scene from a timestamp. */
export function playbackCueHint(transcript: string | null, seconds: number): string {
  const intervals: string[] = [];
  for (const cue of iterSrtCues(transcript ?? "")) {
    if (cue && cue.startSeconds <= seconds && seconds < cue.endSeconds) {
      intervals.push(`${cue.startTime}〜${cue.endTime}`);
      if (intervals.length === 3) break;
    }
  }
  return intervals.length
    ? `再生位置を含む字幕区間は ${intervals.join("、")} です。「今の場面」への回答では、この区間の字幕をツールで取得して根拠とし、この区間を中心に説明してください。`
    : "再生位置を含む字幕区間は特定できていません。現在の場面の内容を断定せず、利用できる根拠を確認してください。";
}
