import { SCENE_INDEX_VERIFY_INTERVAL_MS } from '../../persistence/contracts/scene-index';
import type { SceneIndexVerificationRepository, SceneVectorIdentity } from '../../persistence/contracts/scene-index-verification';
import type { SceneIndexTask, SceneIndexTaskRepository } from '../../persistence/contracts/scene-index';

export type StoredSceneVector = { id: string; values: Iterable<number>; metadata?: Record<string, unknown> };
export interface SceneIndexGateway {
  read(vectorId: string): Promise<StoredSceneVector[]>;
  upsert(task: SceneIndexTask, embedding: number[]): Promise<unknown>;
  remove(vectorId: string): Promise<unknown>;
  queryable(task: SceneIndexTask): Promise<boolean>;
}
export interface SceneIndexSyncDependencies {
  tasks(): SceneIndexTaskRepository;
  indexAvailable(dimensions: 768 | 1536): boolean;
  connect(dimensions: 768 | 1536): SceneIndexGateway;
}

/** Durable retry, source rechecks and readiness decisions are independent of
 * the database and vector SDK. Await all work before returning or rejecting. */
export async function synchronizeSceneIndex(deps: SceneIndexSyncDependencies, limit = 10, options: { concurrency?: number } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid index synchronization limit");
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Invalid index synchronization concurrency");
  const tasks = deps.tasks();
  const result = { claimed: 0, completed: 0, pending: 0, failed: 0, leaseLost: 0 };
  let requested = 0;
  const consume = async () => {
    // Independent reserved slots prevent new writes, propagation checks and
    // deletion from starving one another. The repository falls back to the
    // oldest eligible task whenever the preferred lane is empty.
    while (requested < limit) {
      const slot = requested++;
      const prefer = (["delivery", "readiness", "cleanup"] as const)[slot % 3];
      const task = await tasks.claim({ prefer });
      if (!task) break;
      result.claimed++;
      if (!deps.indexAvailable(task.dimensions)) {
        if (await tasks.retry(task, "VECTORIZE_BINDING_MISSING")) result.failed++;
        else result.leaseLost++;
        continue;
      }
      try {
        const index = deps.connect(task.dimensions);
        const desired = await tasks.isDesired(task.id);
        if (task.operation === "upsert" && desired) {
          if (task.acceptedAt === null) {
            let embedding = task.embedding;
            // A pre-readiness task may already have cleared its payload. Replay
            // the exact stored vector, without calling an embedding model, so a
            // metadata index created during upgrade can index it too.
            if (embedding === null) {
              const recovered = await index.read(task.vectorId);
              const vector = recovered.length === 1 ? recovered[0] : undefined;
              if (!vector || vector.id !== task.vectorId || vector.metadata?.user_id !== task.userId ||
                  vector.metadata?.video_id !== task.videoId || vector.metadata?.scene_id !== task.sceneId ||
                  vector.metadata?.revision !== task.revision || vector.metadata?.vector_id !== task.vectorId) throw new Error("Invalid stored vector");
              embedding = Array.from(vector.values);
            }
            if (embedding.length !== task.dimensions || !embedding.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
                !embedding.some(value => Math.fround(value) !== 0)) throw new Error("Invalid staged embedding");
            await index.upsert(task, embedding);
          }
          // Deletion or a transcript edit may have committed while Vectorize was
          // responding. Remove that immutable version rather than reviving it.
          if (!await tasks.isDesired(task.id)) await index.remove(task.vectorId);
          else {
            if (task.acceptedAt === null && !await tasks.accept(task)) {
              // A replacement may have deleted the source while this write was
              // in flight. Losing the lease must not skip immutable-ID cleanup.
              if (!await tasks.isDesired(task.id)) await index.remove(task.vectorId);
              result.leaseLost++;
              continue;
            }
            if (!await index.queryable(task)) {
              if (await tasks.retry(task, "VECTORIZE_NOT_READY")) result.pending++;
              else result.leaseLost++;
              continue;
            }
          }
        } else if (!desired) {
          await index.remove(task.vectorId);
        }
        if (await tasks.complete(task)) result.completed++;
        else result.leaseLost++;
      } catch {
        // Raw provider errors can contain credentials or request payloads.
        if (await tasks.retry(task, "VECTORIZE_WRITE_FAILED")) result.failed++;
        else result.leaseLost++;
      }
    }
  };
  // Await every worker, including when a DB operation rejects. No provider work
  // may outlive the caller or lose its persisted lease/error bookkeeping.
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, limit) }, consume));
  const failure = outcomes.find(outcome => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return result;
}


export interface SceneIndexVerificationDependencies {
  repository: SceneIndexVerificationRepository;
  readVectors(ids: string[]): Promise<SceneVectorIdentity[]>;
  nowMs(): number;
}

/** Finish all bounded provider reads before recording progress or repair jobs. */
export async function reconcileSceneVectors(deps: SceneIndexVerificationDependencies, dimensions: 768 | 1536, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid index verification limit');
  const due = await deps.repository.due(dimensions, limit);
  if (!due.length) return { verified: 0, repairQueued: 0 };
  const existing = new Map<string, SceneVectorIdentity>();
  try {
    for (const vector of await deps.readVectors(due.map(task => task.vector_id))) {
      existing.set(vector.id, vector);
    }
  } catch { throw new Error('Vectorize index verification failed'); }
  const missing = due.filter(task => {
    const vector = existing.get(task.vector_id);
    if (!vector) return true;
    return Boolean(task.legacy_replay) && (vector.metadata?.user_id !== task.user_id ||
      vector.metadata?.video_id !== task.video_id || vector.metadata?.scene_id !== task.scene_id ||
      vector.metadata?.revision !== task.revision || vector.metadata?.vector_id !== task.vector_id);
  });
  let repairQueued = 0;
  for (const videoId of new Set(missing.map(task => task.video_id))) {
    const revision = missing.find(task => task.video_id === videoId)!.source_revision;
    const dedupeKey = `vector-repair:${dimensions}:${videoId}:${revision}:${Math.floor(deps.nowMs() / SCENE_INDEX_VERIFY_INTERVAL_MS)}`;
    repairQueued += await deps.repository.enqueueRepair({
      dimensions, videoId, dedupeKey,
      missingVectorIds: missing.filter(task => task.video_id === videoId).map(task => task.vector_id),
    });
  }
  await deps.repository.markVerified(due.map(task => task.id));
  return { verified: due.length, repairQueued };
}
