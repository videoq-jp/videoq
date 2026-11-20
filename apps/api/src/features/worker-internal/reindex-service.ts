import type { ReindexRepository } from '../../persistence/contracts/reindex-repository';

export type ReindexConfiguration = { dimensions: number; profile: string; model: string };
export type ReindexPageInput = ReindexConfiguration & { afterId: number };
export interface ReindexPageDependencies {
  repository(): Promise<ReindexRepository>;
  configuration(): Promise<ReindexConfiguration>;
  indexDimensions(dimensions: number): Promise<number | null>;
}

/** An empty page requires no provider. Nonempty work must match the live index. */
export async function readReindexPage(deps: ReindexPageDependencies, input: ReindexPageInput) {
  const ids = await (await deps.repository()).candidateIds(input.afterId);
  if (!ids.length) return ids;
  const config = await deps.configuration();
  if (config.dimensions !== input.dimensions || config.profile !== input.profile || config.model !== input.model) {
    throw new Error('Embedding configuration mismatch');
  }
  if (await deps.indexDimensions(config.dimensions) !== config.dimensions) throw new Error('Vector index is not ready');
  return ids;
}
