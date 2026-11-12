import {
  ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, Quality, StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny';
import { COMPRESSION_DIRECTORY, compressionDimensions, type CompressionMessage, type CompressionPreset } from './videoCompressionSettings';

type Start = { type: 'start'; file: File; preset: CompressionPreset; name: string; maxBytes: number };
let conversion: Conversion | undefined;
let canceled = false;
let started = false;
const send = (message: CompressionMessage) => self.postMessage(message);
const checkCanceled = () => { if (canceled) throw new DOMException('Canceled', 'AbortError'); };

// This is a DedicatedWorkerGlobalScope, created only by videoCompression.ts.
// Its messages come through the creator's private Worker channel; it is not a
// Window message listener and worker MessageEvent.origin is the empty string.
self.onmessage = ({ data }: MessageEvent<Start | { type: 'cancel' }>) => {
  if (data.type === 'cancel') {
    canceled = true;
    void conversion?.cancel().catch(() => undefined);
  } else if (!started) {
    started = true;
    void convert(data);
  }
};

async function convert({ file, preset, name, maxBytes }: Start) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }) });
  let output: Output | undefined;
  let disk: FileSystemWritableFileStream | undefined;
  let complete = false;
  try {
    const videos = await input.getVideoTracks();
    // Multiple angles/attachments need an explicit selection UI; never drop them silently.
    if (videos.length !== 1) throw new Error('videos.upload.compression.unsupportedFile');
    const video = videos[0];
    if (await video.hasHighDynamicRange()) {
      throw new Error('videos.upload.compression.unsupportedFile');
    }
    const dimensions = compressionDimensions(await video.getDisplayWidth(), await video.getDisplayHeight(), preset);
    const stats = await video.computePacketStats(120);
    const targetRate = Math.min(preset === '1080p' ? 60 : 30, stats.averagePacketRate);
    if (!Number.isFinite(targetRate) || targetRate <= 0) throw new Error('videos.upload.compression.unsupportedFile');
    // Keep the source cadence at <= 60fps in standard mode, rather than doubling low-fps footage.
    const presetBitrate = preset === '1080p' ? (targetRate > 30 ? 8_000_000 : 5_000_000) : 2_500_000;
    // Re-encode low-bitrate inputs without inflating them to the preset ceiling.
    const bitrate = Number.isFinite(stats.averageBitrate) && stats.averageBitrate > 0
      ? Math.min(presetBitrate, Math.max(64_000, Math.floor(stats.averageBitrate * 0.9)))
      : presetBitrate;
    const duration = await input.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('videos.upload.compression.unsupportedFile');
    const audioTracks = await input.getAudioTracks();
    const audioStats = await Promise.all(audioTracks.map(track => track.computePacketStats(100)));
    const audioBitrate = audioStats.reduce((sum, stats) => sum + stats.averageBitrate, 0);
    // Estimates are approximate; runtime writes still handle quota exhaustion.
    // A large extra reserve would reject 9 GB outputs against a 10 GiB quota.
    const estimate = (bitrate + audioBitrate) / 8 * duration * 1.05;
    const storage = await navigator.storage.estimate();
    if (storage.quota !== undefined && storage.usage !== undefined && storage.quota - storage.usage < estimate) {
      throw new Error('videos.upload.compression.noSpace');
    }
    checkCanceled();
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(COMPRESSION_DIRECTORY, { create: true });
    const handle = await directory.getFileHandle(name, { create: true });
    disk = await handle.createWritable();
    const writable = disk;
    output = new Output({
      // Regular MP4 supports edit lists for delayed tracks.
      // Media streams directly to disk; only sample metadata is retained in memory.
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          checkCanceled();
          const end = chunk.position + chunk.data.byteLength;
          if (end > maxBytes) throw new Error('videos.upload.compression.tooLarge');
          await writable.write(chunk);
        },
        close: () => writable.close(),
        abort: () => writable.abort(),
      }), { chunked: true, chunkSize: 2 * 1024 * 1024 }),
    });
    conversion = await Conversion.init({
      input, output,
      video: {
        ...dimensions, fit: 'contain', codec: 'avc', quality: new Quality({ bitrate }),
        frameRate: targetRate,
        // Native software AVC encoding must remain usable without a hardware encoder.
        hardwareAcceleration: 'no-preference', keyFrameInterval: 2, allowTransformationMetadata: false,
      },
      // Copy audio whenever MP4 supports it. No audio bitrate reduction is requested.
      audio: {}, showWarnings: false,
    });
    if (!conversion.isValid || conversion.discardedTracks.length > 0
      || conversion.utilizedTracks.filter(track => track.isAudioTrack()).length !== audioTracks.length) {
      throw new Error('videos.upload.compression.unsupportedFile');
    }
    checkCanceled();
    let previous = -1;
    conversion.onProgress = progress => {
      const percent = Math.min(99, Math.floor(progress * 100));
      if (percent !== previous) { previous = percent; send({ type: 'progress', percent }); }
    };
    await conversion.execute();
    checkCanceled();
    const result = await handle.getFile();
    if (!result.size) throw new Error('videos.upload.compression.failed');
    complete = true;
    send({ type: 'done', file: new File([result], `${file.name.replace(/\.[^/.]+$/, '')}-${preset}.mp4`, { type: 'video/mp4' }) });
  } catch (error) {
    // Do not expose decoder internals or silently upload the uncompressed original.
    const message = error instanceof Error ? error.message : '';
    const code = error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'videos.upload.compression.noSpace'
      : message.startsWith('videos.upload.compression.') ? message : 'videos.upload.compression.failed';
    // Close file handles before the main thread removes this attempt's temporary file.
    await conversion?.cancel().catch(() => undefined);
    await output?.cancel().catch(() => undefined);
    await disk?.abort().catch(() => undefined);
    send({ type: 'error', code });
  } finally {
    input.dispose();
    if (!complete) await disk?.abort().catch(() => undefined);
  }
}
