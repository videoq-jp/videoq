export type VisualRun = { videoId: number; runId: string; fileKey: string; durationMs: number; chunkCount: number; status: string;publicationVersion:string|null };
export type VisualChunk = { index: number; frameCount: number | null; objectVersion: string | null };
export interface VisualCheckpoints {
  load(videoId: number, runId?: string): Promise<VisualRun | null>;
  initialize(videoId: number, fileKey: string, durationMs: number): Promise<VisualRun | null>;
  beginObject(videoId:number,runId:string,objectVersion:string,index?:number):Promise<boolean>;
  pending(runId: string): Promise<number[]>;
  chunks(videoId: number, runId: string): Promise<VisualChunk[] | null>;
  publishChunk(videoId: number, runId: string, index: number, frameCount: number, objectVersion: string): Promise<{ current: boolean; objectVersion: string | null }>;
  ready(videoId: number, runId: string,objectVersion:string): Promise<boolean>;
  failure(videoId: number, runId: string, index?: number): Promise<void>;
}
