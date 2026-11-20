import type { TranscriptionFailure, TranscriptionStatus } from '../../application/transcription-policy';
export type WorkerTranscriptionSource = {
  videoId: number; userId: string; title: string; sourceRevision: string;
  fileKey: string; status: string; sourceType: string; youtubeVideoId: string;
  transcriptionLanguage: string | null;
  searchapiKeyEncrypted: string | null;
};
export type TranscriptionSnapshot = Pick<WorkerTranscriptionSource, "videoId" | "userId" | "sourceRevision" | "fileKey">;
export interface WorkerTranscriptionRepository {
  readSource(videoId: number): Promise<WorkerTranscriptionSource | null>;
  begin(snapshot: TranscriptionSnapshot, expectedStatus: TranscriptionStatus): Promise<boolean>;
  finish(snapshot: TranscriptionSnapshot, transcript: string | null, errorCode: TranscriptionFailure | null, runId?: string): Promise<string | null>;
}
