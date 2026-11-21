export type ChatSource = {
  id: number; video_id: number; title: string; start_time: string | null; end_time: string | null;
  evidence_type?: 'transcript' | 'visual';
};
export type ModelAnswer = { segments: Array<{ text: string; sourceIds: number[] }> };
export type ChatAnswer = { segments: ModelAnswer['segments']; sources: ChatSource[] };
export const chatAnswerText = (answer: ChatAnswer): string => answer.segments.map(segment => segment.text).join('');
export const plainChatAnswer = (text: string): ChatAnswer => ({ segments: [{ text, sourceIds: [] }], sources: [] });
export const CHAT_TOOL_NAMES = ['get_course_info', 'search_scenes', 'overview_video', 'skim_video', 'read_video_window', 'inspect_clip', 'focus_clip'] as const;
export type ChatToolProgressEvent = { type: 'tool_progress'; call_id: number; tool: typeof CHAT_TOOL_NAMES[number]; status: 'running' | 'complete' | 'error' };
export const CHAT_GENERATION_PHASES = ['thinking', 'summarizing', 'reviewing', 'answering'] as const;
export type ChatGenerationProgressEvent = { type: 'generation_progress'; phase: typeof CHAT_GENERATION_PHASES[number] };
export type ChatStreamEvent =
  | ChatGenerationProgressEvent
  | ChatToolProgressEvent
  | { type: 'source'; source: ChatSource }
  | { type: 'text_delta'; segmentIndex: number; text: string }
  | { type: 'citation'; segmentIndex: number; sourceId: number }
  | { type: 'searching'; query: string; search_id: number }
  | { type: 'search_completed'; query: string; search_id: number; result_count: number }
  | { type: 'done'; chat_log_id: number | null; feedback: 'good' | 'bad' | null; feedback_token?: string }
  | { type: 'error'; code: string; message: string };
