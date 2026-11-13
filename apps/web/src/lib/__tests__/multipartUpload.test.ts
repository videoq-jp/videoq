import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { multipartPartSize } from '@videoq/trpc/video-upload';
import { uploadMultipartFile } from '../multipartUpload';

const etag = 'a'.repeat(32);
class TestXhr extends EventTarget {
  static requests: TestXhr[] = [];
  static active = 0;
  static maximumActive = 0;
  static reply: (xhr: TestXhr) => void;
  upload = new EventTarget();
  status = 200;
  responseText = '';
  responseEtag: string | null = `"${etag}"`;
  url = '';
  body!: Blob;
  aborted = false;
  settled = false;
  timeout = 0;
  headers = new Map<string, string>();
  open(method: string, url: string) { expect(method).toBe('PUT'); this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  getResponseHeader(name: string) { expect(name).toBe('ETag'); return this.responseEtag; }
  send(body: Blob) {
    this.body = body;
    TestXhr.requests.push(this);
    TestXhr.active++;
    TestXhr.maximumActive = Math.max(TestXhr.active, TestXhr.maximumActive);
    queueMicrotask(() => { if (!this.settled) TestXhr.reply(this); });
  }
  finish(status = 200) {
    if (this.settled) return;
    this.status = status;
    this.upload.dispatchEvent(new ProgressEvent('progress', { loaded: this.body.size, total: this.body.size, lengthComputable: true }));
    this.settled = true;
    TestXhr.active--;
    this.dispatchEvent(new Event('load'));
  }
  abort() {
    if (this.settled) return;
    this.aborted = true;
    this.settled = true;
    TestXhr.active--;
    this.dispatchEvent(new Event('abort'));
  }
}

beforeEach(() => {
  TestXhr.requests = [];
  TestXhr.active = 0;
  TestXhr.maximumActive = 0;
  TestXhr.reply = xhr => xhr.finish();
  vi.stubGlobal('XMLHttpRequest', TestXhr);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function operations() {
  return {
    partUrl: vi.fn(async (part: number) => ({ upload_url: `https://storage.test/?partNumber=${part}` })),
    complete: vi.fn(async () => ({ id: 7 })),
    abort: vi.fn(async () => {}),
  };
}

describe('multipart video transfer', () => {
  it('uploads 45.16 GB using bounded slices and at most three concurrent requests', async () => {
    const size = 45_160_000_000;
    const partSize = multipartPartSize(size);
    const count = Math.ceil(size / partSize);
    const file = new File([], 'recording.mkv');
    Object.defineProperty(file, 'size', { value: size });
    const slice = vi.spyOn(file, 'slice').mockImplementation((start = 0, end = size, type) => {
      const blob = new Blob([], { type });
      Object.defineProperty(blob, 'size', { value: end - start });
      return blob;
    });
    const api = operations();
    const progress = vi.fn();
    await expect(uploadMultipartFile(file, 'video/matroska', { part_size: partSize, part_count: count }, api, progress)).resolves.toEqual({ id: 7 });
    expect(slice).toHaveBeenCalledTimes(count);
    expect(slice).toHaveBeenLastCalledWith((count - 1) * partSize, size, 'video/matroska');
    expect(TestXhr.maximumActive).toBe(3);
    expect(TestXhr.requests.reduce((sum, xhr) => sum + xhr.body.size, 0)).toBe(size);
    expect(TestXhr.requests.every(xhr => xhr.body.size <= partSize && xhr.headers.get('Content-Type') === 'video/matroska')).toBe(true);
    expect(api.complete).toHaveBeenCalledExactlyOnceWith(Array.from({ length: count }, (_, index) => ({ partNumber: index + 1, etag })));
    expect(progress.mock.calls.slice(0, -1).every(([percent]) => percent < 100)).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(api.abort).not.toHaveBeenCalled();
  });

  it('retries only a failed part with a fresh URL and keeps progress monotonic', async () => {
    vi.useFakeTimers();
    const api = operations();
    let attempts = 0;
    TestXhr.reply = xhr => xhr.finish(xhr.url.endsWith('=2') && attempts++ === 0 ? 503 : 200);
    const progress = vi.fn();
    const promise = uploadMultipartFile(new File(['12345678901'], 'clip.mp4'), 'video/mp4', { part_size: 5, part_count: 3 }, api, progress);
    await vi.runAllTimersAsync();
    await promise;
    expect(api.partUrl.mock.calls.map(([part]) => part).sort()).toEqual([1, 2, 2, 3]);
    const values = progress.mock.calls.map(([value]) => value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(api.complete).toHaveBeenCalledTimes(1);
  });

  it('aborts the remaining PUTs and cleans up after a permanent storage error', async () => {
    const api = operations();
    TestXhr.reply = xhr => { if (xhr.url.endsWith('=1')) { xhr.responseText = '<Error><Code>EntityTooLarge</Code></Error>'; xhr.finish(400); } };
    await expect(uploadMultipartFile(new File(['12345678901234567890'], 'clip.mp4'), 'video/mp4', { part_size: 5, part_count: 4 }, api)).rejects.toThrow('400 (EntityTooLarge)');
    expect(TestXhr.requests).toHaveLength(3);
    expect(TestXhr.requests.slice(1).every(xhr => xhr.aborted)).toBe(true);
    expect(TestXhr.active).toBe(0);
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.abort).toHaveBeenCalledTimes(1);
  });

  it('preserves opaque R2 part ETags rather than requiring MD5', async () => {
    const opaque='r2_opaque-part/value+suffix=';
    TestXhr.reply=xhr=>{xhr.responseEtag=`"${opaque}"`;xhr.finish();};
    const api=operations();await uploadMultipartFile(new File(['123'],'clip.mp4'),'video/mp4',{part_size:5,part_count:1},api);
    expect(api.complete).toHaveBeenCalledExactlyOnceWith([{partNumber:1,etag:opaque}]);
  });
  it.each(['"mismatched','invalid\nheader','x'.repeat(1025)])('rejects malformed or oversized ETags (%s)', async raw=>{
    TestXhr.reply=xhr=>{xhr.responseEtag=raw;xhr.finish();};const api=operations();
    await expect(uploadMultipartFile(new File(['123'],'clip.mp4'),'video/mp4',{part_size:5,part_count:1},api)).rejects.toThrow('ETag');expect(api.complete).not.toHaveBeenCalled();
  });
  it('reports missing CORS ETag without completing an unverifiable upload', async () => {
    TestXhr.reply = xhr => { xhr.responseEtag = null; xhr.finish(); };
    const api = operations();
    await expect(uploadMultipartFile(new File(['123'], 'clip.mp4'), 'video/mp4', { part_size: 5, part_count: 1 }, api)).rejects.toThrow('ETag');
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.abort).toHaveBeenCalledTimes(1);
  });

  it('retries a lost completion response without sending video parts again', async () => {
    vi.useFakeTimers();
    const api = operations();
    api.complete.mockRejectedValueOnce(new Error('Network error'));
    const promise = uploadMultipartFile(new File(['123'], 'clip.mp4'), 'video/mp4', { part_size: 5, part_count: 1 }, api);
    await vi.runAllTimersAsync();
    await promise;
    expect(TestXhr.requests).toHaveLength(1);
    expect(api.complete).toHaveBeenCalledTimes(2);
    expect(api.abort).not.toHaveBeenCalled();
  });
});
