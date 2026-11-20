import { compressVideo, supportsVideoCompression } from '../videoCompression';
import { compressionEncoding, compressionStorageEstimate } from '@/application/video-compression';
import { compressionDimensions, COMPRESSION_DIRECTORY } from '../videoCompressionSettings';

class FakeWorker {
  static current: FakeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.current = this; }
}

const removeEntry = vi.fn(async () => {});
const getDirectoryHandle = vi.fn(async () => ({ removeEntry }));
const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('VideoEncoder', class {});
  vi.stubGlobal('VideoDecoder', class {});
  Object.defineProperty(navigator, 'storage', { configurable: true, value: {
    getDirectory: vi.fn(async () => ({ getDirectoryHandle })),
  } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
  else Reflect.deleteProperty(navigator, 'storage');
});

it('keeps the compressed backing file available until upload cleanup', async () => {
  const source = new File(['original video'], 'source.mkv');
  const progress = vi.fn();
  const promise = compressVideo(source, '1080p', { signal: new AbortController().signal, maxBytes: 100, onProgress: progress });
  await vi.waitFor(() => expect(FakeWorker.current.postMessage).toHaveBeenCalled());
  const start = FakeWorker.current.postMessage.mock.calls[0][0];
  expect(start).toMatchObject({ type: 'start', file: source, preset: '1080p', maxBytes: 100 });
  const output = new File(['small'], 'source-1080p.mp4');
  FakeWorker.current.onmessage?.({ data: { type: 'done', file: output } });
  const result = await promise;
  expect(result.file).toBe(output);
  expect(removeEntry).not.toHaveBeenCalled();
  await result.dispose();
  expect(getDirectoryHandle).toHaveBeenCalledWith(COMPRESSION_DIRECTORY, { create: true });
  expect(removeEntry).toHaveBeenCalledWith(start.name);
  expect(start.name).not.toBe(source.name);
  expect(FakeWorker.current.terminate).toHaveBeenCalledTimes(1);
});

it('bounds cancellation even if a decoder never responds', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const promise = compressVideo(new File(['video'], 'source.mkv'), '720p', {
    signal: controller.signal, maxBytes: 100, onProgress: vi.fn(),
  });
  const outcome = promise.catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(FakeWorker.current.terminate).toHaveBeenCalled();
  expect(removeEntry).toHaveBeenCalledTimes(1);
});

it('fails without starting a worker when browser support is missing', async () => {
  vi.stubGlobal('VideoEncoder', undefined);
  expect(supportsVideoCompression()).toBe(false);
  await expect(compressVideo(new File(['v'], 'source.mkv'), '720p', {
    signal: new AbortController().signal, maxBytes: 100, onProgress: vi.fn(),
  })).rejects.toThrow('videos.upload.compression.unsupported');
  expect(getDirectoryHandle).not.toHaveBeenCalled();
});

it('fits portrait and landscape frames without upscaling', () => {
  expect(compressionDimensions(3840, 2160, '1080p')).toEqual({ width: 1920, height: 1080 });
  expect(compressionDimensions(2160, 3840, '720p')).toEqual({ width: 720, height: 1280 });
  expect(compressionDimensions(640, 480, '1080p')).toEqual({ width: 640, height: 480 });
});

it('retains source cadence, caps high-rate footage and avoids bitrate inflation', () => {
  expect(compressionEncoding('1080p', 24, 1_000_000)).toEqual({ frameRate: 24, bitrate: 900_000 });
  expect(compressionEncoding('1080p', 120, 20_000_000)).toEqual({ frameRate: 60, bitrate: 8_000_000 });
  expect(compressionEncoding('1080p', 30, Number.NaN)).toEqual({ frameRate: 30, bitrate: 5_000_000 });
  expect(compressionEncoding('720p', 60, 20_000_000)).toEqual({ frameRate: 30, bitrate: 2_500_000 });
  expect(compressionEncoding('720p', 24, 10_000)).toEqual({ frameRate: 24, bitrate: 64_000 });
  for (const rate of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    expect(compressionEncoding('1080p', rate, 1_000_000)).toBeNull();
  }
});

it('includes copied audio and five percent overhead in temporary storage estimates', () => {
  expect(compressionStorageEstimate(8_000_000, 256_000, 3600)).toBe(3_900_960_000);
});
