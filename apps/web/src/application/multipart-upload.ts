export type UploadedPart = { partNumber: number; etag: string };

export interface MultipartDependencies<Body, Result> {
  size: number;
  partSize: number;
  partCount: number;
  slice(start: number, end: number): Body;
  bodySize(body: Body): number;
  partUrl(partNumber: number): Promise<string>;
  upload(url: string, body: Body, progress: (bytes: number) => void): Promise<string>;
  complete(parts: UploadedPart[]): Promise<Result>;
  abortSession(): Promise<unknown>;
  throwIfCancelled(): void;
  cancelled(): boolean;
  cancel(reason: unknown): void;
  retryable(error: unknown): boolean;
  wait(milliseconds: number): Promise<void>;
}

export async function executeMultipartUpload<Body, Result>(deps: MultipartDependencies<Body, Result>, onProgress?: (percent: number) => void): Promise<Result> {
  async function retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      deps.throwIfCancelled();
      try { return await operation(); }
      catch (error) {
        if (deps.cancelled() || attempt >= 6 || !deps.retryable(error)) throw error;
        await deps.wait(Math.min(30000, 1000 * 2 ** attempt));
      }
    }
  }
  const uploaded = new Float64Array(deps.partCount);
  const parts: UploadedPart[] = new Array<UploadedPart>(deps.partCount);
  let next = 0;
  let percent = 0;
  const progress = (index: number, bytes: number) => {
    uploaded[index] = bytes;
    const total = uploaded.reduce((sum, value) => sum + value, 0);
    percent = Math.max(percent, Math.min(99, Math.floor(total / deps.size * 100)));
    onProgress?.(percent);
  };
  const worker = async () => {
    try {
      while (next < deps.partCount) {
        deps.throwIfCancelled();
        const index = next++;
        const body = deps.slice(index * deps.partSize, Math.min((index + 1) * deps.partSize, deps.size));
        const etag = await retry(async () => {
          progress(index, 0);
          const url = await deps.partUrl(index + 1);
          deps.throwIfCancelled();
          return deps.upload(url, body, bytes => progress(index, bytes));
        });
        parts[index] = { partNumber: index + 1, etag };
        progress(index, deps.bodySize(body));
      }
    } catch (error) {
      deps.cancel(error);
      throw error;
    }
  };
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, deps.partCount) }, worker));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const result = await retry(() => deps.complete(parts));
    onProgress?.(100);
    return result;
  } catch (error) {
    deps.cancel(error);
    // Every transfer settles before abandoning the unconfirmed storage session.
    try { await deps.abortSession(); }
    catch { /* Durable reconciliation retries cleanup. */ }
    throw error;
  }
}
