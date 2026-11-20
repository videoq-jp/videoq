import { iterSrtCues } from "@videoq/domain/transcript";

export const INVALID_SRT_MESSAGE = "Transcript must be in valid SRT format.";

/** 不正ならエラー。空/空白のみは字幕を消去する有効な入力。 */
export function validateTranscriptSrt(value: string): string | null {
  for (const cue of iterSrtCues(value)) {
    if (!cue) return INVALID_SRT_MESSAGE;
  }
  return null;
}
