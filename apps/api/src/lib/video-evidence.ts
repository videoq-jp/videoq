/** Compatibility exports and physical cache format helpers for storage adapters. */
export * from '../domain/conversation/video-evidence';
export const MAX_FRAME_CACHE_BYTES = 16 * 1024 * 1024;
export const frameCacheKey = (fileKey: string) => `${fileKey}.frames-v1.json`;
export const focusCacheKey = (fileKey: string) => `${fileKey}.focus-v1.bin`;
