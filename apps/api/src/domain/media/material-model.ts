export type MaterialCommand =
  | { action: 'get'; videoId: number }
  | { action: 'update'; videoId: number; operationId: string; revision: string; fields: { description?: string; transcript?: string } }
  | { action: 'reindex'; videoId: number; operationId: string; revision: string }
  | { action: 'retry'; videoId: number; operationId: string; revision: string };
export type MaterialView = {
  videoId: number; title: string; description: string; transcript: string; status: string; revision: string;
  canEdit: boolean; canReindex: boolean; canRetry: boolean; jobState: string;
};
export type ManagedVideo={title:string;description:string|null;transcript:string|null;status:string;file:string};
export type MaterialJob={id:string|number;message:unknown;dead:boolean;status:string|null};
export type ReadableManagedVideo = ManagedVideo & { description: string; transcript: string };
export type MaterialTranscriptionMessage = { type: 'transcribe_video'; job_id: string; payload: { video_id: number } };
