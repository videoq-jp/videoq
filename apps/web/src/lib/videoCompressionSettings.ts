export type { CompressionPreset } from '../application/video-compression';
export { compressionDimensions } from '../application/video-compression';
export type CompressedVideo = { file: File; dispose: () => Promise<void> };
export type CompressionMessage =
  | { type: 'progress'; percent: number }
  | { type: 'done'; file: File }
  | { type: 'error'; code: string };

export const COMPRESSION_DIRECTORY = 'videoq-upload-compression';
