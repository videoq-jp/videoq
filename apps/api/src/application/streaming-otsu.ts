import { normalizedOtsuVector, accumulateOtsuTotal, accumulateOtsuBoundary, type OtsuCheckpoint } from '../domain/search/streaming-otsu';
export type { OtsuCheckpoint } from '../domain/search/streaming-otsu';
export interface StreamingOtsuDependencies {
  dimensions: number;
  batchSize: number;
  batchesPerStep: number;
  readBatch(offset: number): Promise<number[][]>;
  checkpoint(name: string, operation: () => Promise<OtsuCheckpoint>): Promise<OtsuCheckpoint>;
}

/** Exact sequential accumulation with bounded memory and small durable results. */
export async function streamingOtsuBoundary(start: number, end: number, deps: StreamingOtsuDependencies): Promise<number> {
  const count = end - start + 1;
  if (count < 2) return 0;
  if (![start, end, deps.dimensions, deps.batchSize, deps.batchesPerStep].every(Number.isSafeInteger) ||
      start < 0 || deps.dimensions <= 0 || deps.batchSize <= 0 || deps.batchesPerStep <= 0) throw new Error('Invalid streaming Otsu configuration');
  const first = Math.floor(start / deps.batchSize) * deps.batchSize;
  const stride = deps.batchSize * deps.batchesPerStep;
  const zero = (): OtsuCheckpoint => ({ sum: Array<number>(deps.dimensions).fill(0), criterion: -1, boundary: 1 });
  const visit = async (offset: number, operation: (index: number, vector: number[]) => void) => {
    for (let batch = offset; batch <= end && batch < offset + stride; batch += deps.batchSize) {
      const vectors = await deps.readBatch(batch);
      const upper = Math.min(end + 1, batch + deps.batchSize);
      if (vectors.length < upper - batch) throw new Error('Missing scene splitting vectors');
      for (let index = Math.max(start, batch); index < upper; index++) {
        const vector = vectors[index - batch];
        operation(index, normalizedOtsuVector(vector, deps.dimensions));
      }
    }
  };
  let total = zero();
  for (let offset = first; offset <= end; offset += stride) {
    const previous = total;
    total = await deps.checkpoint(`split-total-${start}-${end}-${offset}`, async () => {
      const state = { ...previous, sum: [...previous.sum] };
      await visit(offset, (_index, vector) => { accumulateOtsuTotal(state, vector); });
      return state;
    });
  }
  let prefix = zero();
  for (let offset = first; offset <= end; offset += stride) {
    const previous = prefix;
    prefix = await deps.checkpoint(`split-boundary-${start}-${end}-${offset}`, async () => {
      const state = { ...previous, sum: [...previous.sum] };
      await visit(offset, (index, vector) => {
        accumulateOtsuBoundary(state, total, vector, index - start + 1, count);
      });
      return state;
    });
  }
  return prefix.boundary;
}
