/** Application data, independent of RPC schemas and inference frameworks. */
export type VideoStatus = 'uploading' | 'pending' | 'processing' | 'indexing' | 'completed' | 'error';
export type VideoSourceType = 'uploaded' | 'youtube';

export type ChatSource = {
  id: number;
  video_id: number;
  title: string;
  start_time: string | null;
  end_time: string | null;
  evidence_type?: 'transcript' | 'visual';
};
export type ChatAnswer = {
  segments: { text: string; sourceIds: number[] }[];
  sources: ChatSource[];
};
