import { iterSrtCues } from '@videoq/domain/transcript';

export interface TranscriptSegment {
  timestamp: string;
  seconds: number;
  text: string;
}

export function parseSrtTranscript(srt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const cue of iterSrtCues(srt)) {
    if (!cue) continue;
    segments.push({
      timestamp: cue.startTime.split(/[,.]/)[0],
      seconds: cue.startSeconds,
      text: cue.text.replaceAll('\n', ' '),
    });
  }

  return segments;
}

export function filterTranscriptSegments(
  segments: TranscriptSegment[],
  query: string,
): TranscriptSegment[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return segments;
  }
  return segments.filter((segment) =>
    segment.text.toLowerCase().includes(normalizedQuery),
  );
}
