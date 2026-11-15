import type { TranscriptionSnapshot } from "./worker-transcription";
export type TranscriptionRun = {
  videoId: number; runId: string; fileKey: string; sourceRevision: string;
  durationMs: number; chunkSeconds: number; chunkCount: number;
  completed: boolean; transcriptionLanguage: string | null;
};
export type TranscriptSegment = { start: number; end: number; text: string };
export interface TranscriptionCheckpoints {
  load(videoId: number, runId?: string): Promise<TranscriptionRun | null>;
  initialize(input: TranscriptionSnapshot, durationMs: number, chunkSeconds: number): Promise<{ run: TranscriptionRun | null; quotaExceeded: boolean }>;
  pendingHeads(runId: string, afterIndex?: number): Promise<number[]>;
  chunkState(videoId: number, runId: string, index: number): Promise<{ active: boolean; completed: boolean }>;
  saveChunk(videoId: number, runId: string, index: number, segments: TranscriptSegment[]): Promise<boolean>;
  readSegments(videoId: number, runId: string, afterIndex: number): Promise<{ active: boolean; rows: { index: number; segments: TranscriptSegment[] | null }[]; done: boolean }>;
  rejectNoAudio(input: TranscriptionSnapshot, runId?: string, index?: number): Promise<boolean>;
  recordFailure(videoId: number, runId: string, index: number): Promise<void>;
}
