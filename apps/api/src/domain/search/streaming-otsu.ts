export interface OtsuCheckpoint {
  sum: number[];
  criterion: number;
  boundary: number;
}

export function normalizedOtsuVector(vector: number[], dimensions: number): number[] {
  if (vector.length !== dimensions || vector.some(value => !Number.isFinite(value))) throw new Error('Invalid scene splitting vector');
  const norm = Math.max(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)), 1e-12);
  return vector.map(value => value / norm);
}
/** Checkpoint-local state is caller-owned; these operations perform no I/O. */
export function accumulateOtsuTotal(state: OtsuCheckpoint, vector: number[]): void {
  for (let d = 0; d < vector.length; d++) state.sum[d] += vector[d];
}
export function accumulateOtsuBoundary(state: OtsuCheckpoint, total: OtsuCheckpoint, vector: number[], tau: number, count: number): void {
  let squared = 0;
  for (let d = 0; d < vector.length; d++) {
    state.sum[d] += vector[d];
    const difference = state.sum[d] * count - tau * total.sum[d];
    squared += difference * difference;
  }
  if (tau < count) {
    const criterion = squared / (tau * (count - tau));
    if (criterion > state.criterion) { state.criterion = criterion; state.boundary = tau; }
  }
}
