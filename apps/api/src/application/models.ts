/** Application data, independent of RPC schemas and inference frameworks. */
export type VideoStatus = 'uploading' | 'pending' | 'processing' | 'indexing' | 'completed' | 'error';
export type VideoSourceType = 'uploaded' | 'youtube';

export type { ChatSource, ChatAnswer } from '@videoq/domain/chat';
