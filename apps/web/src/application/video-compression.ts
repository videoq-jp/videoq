export type CompressionPreset = '1080p' | '720p';

/** Keep source cadence and avoid inflating low-bitrate inputs. */
export function compressionEncoding(preset: CompressionPreset, sourceRate: number, sourceBitrate: number) {
  const frameRate = Math.min(preset === '1080p' ? 60 : 30, sourceRate);
  if (!Number.isFinite(frameRate) || frameRate <= 0) return null;
  const ceiling = preset === '1080p' ? (frameRate > 30 ? 8_000_000 : 5_000_000) : 2_500_000;
  const bitrate = Number.isFinite(sourceBitrate) && sourceBitrate > 0
    ? Math.min(ceiling, Math.max(64_000, Math.floor(sourceBitrate * 0.9)))
    : ceiling;
  return { frameRate, bitrate };
}

/** Approximate temporary storage; actual writes still enforce the byte limit. */
export function compressionStorageEstimate(videoBitrate: number, audioBitrate: number, duration: number): number {
  return (videoBitrate + audioBitrate) / 8 * duration * 1.05;
}

/** Small, even dimensions; never upscale or crop portrait/landscape inputs. */
export function compressionDimensions(width: number, height: number, preset: CompressionPreset) {
  const long = preset === '1080p' ? 1920 : 1280;
  const short = preset === '1080p' ? 1080 : 720;
  const scale = Math.min(1, long / Math.max(width, height), short / Math.min(width, height));
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}
