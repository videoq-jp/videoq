import pg from 'pg';
import { executeTranscriptIndex } from '../../application/search-index-execution';
import { executeSceneIndex } from '../../application/scene-index-execution';
import { embeddingDimensions, embeddingTable, resolveEmbeddingConfig } from '../../lib/embedding-contract';
import { embedTexts } from '../../lib/embeddings';
import { armMaintenance } from '../../lib/task-scheduler';
import { createWorkerScenePersistence } from '../../persistence/factory';
import { persistenceBackend } from '../../persistence/backend';
import { databaseConnectionString } from '../../db/pool';
import { replacePostgresTranscriptIndex, validateTranscriptVectorStorage, clearPostgresTranscriptIndex } from '../../persistence/postgres/transcript-index-writer';
import { splitTranscriptForIndex } from './scene-splitter';
import { sceneIndexCount } from './outcome';
import type { Bindings } from '../../types/bindings';

export async function indexTranscript(env: Bindings, videoId: number, options: { finishIndexing?: boolean; allowEmpty?: boolean } = {}, signal?: AbortSignal): Promise<number> {
  const config = resolveEmbeddingConfig(env);
  const dimensions = embeddingDimensions(config) as 768 | 1536;
  if (env.PGVECTOR_COLLECTION_NAME?.trim() && env.PGVECTOR_COLLECTION_NAME.trim() !== embeddingTable(config)) {
    throw new Error('Vector table does not match the selected embedding profile');
  }
  const embed = (texts: string[]) => embedTexts(env, texts, 'document', signal);
  const split = (transcript: string) => splitTranscriptForIndex(env, transcript, signal);
  if (persistenceBackend(env) === 'd1') {
    const { writer, readSource, finish } = await createWorkerScenePersistence(env);
    if (env.TASK_SCHEDULER) await armMaintenance(env, Date.now() + 1000);
    return sceneIndexCount(await executeSceneIndex(videoId, {
      load: readSource, finish: source => finish({ ...source, dimensions }),
      newRunId: () => crypto.randomUUID(), dimensions, embed, split,
      start: input => writer.start(input), stage: (run, user, scenes) => writer.stage(run, user, scenes),
      publish: (run, user) => writer.publish(run, user),
    }, options));
  }
  const ownPool = !env.DATABASE_POOL;
  const pool = env.DATABASE_POOL ?? new pg.Pool({ connectionString: databaseConnectionString(env), max: 2 });
  const storage = { table: embeddingTable(config), dimensions };
  try {
    const { rows } = await pool.query<{ id: number; user_id: string; transcript: string; status: string; file: string | null }>(
      'SELECT id,user_id,transcript,status,file FROM videos WHERE id=$1', [videoId],
    );
    const source = rows[0];
    if (!source) return 0;
    if (options.finishIndexing && source.status === 'completed') return 0;
    if (options.finishIndexing && source.status !== 'indexing') throw new Error('Video is not ready for indexing');
    const empty = !(source.transcript ?? '').trim();
    if (empty && options.finishIndexing && !options.allowEmpty) throw new Error('Video has no transcript');
    const result = empty ? await clearPostgresTranscriptIndex(pool, { videoId, userId: source.user_id, transcript: source.transcript ?? '' }) : await executeTranscriptIndex(videoId, source.transcript, {
      prepareReplacement: async () => {
        await validateTranscriptVectorStorage(pool, storage);
        return (scenes, vectors) => replacePostgresTranscriptIndex(pool, storage, {
          videoId, userId: source.user_id, transcript: source.transcript,
        }, scenes, vectors);
      }, split, embed,
    });
    if (options.finishIndexing) {
      const updated = await pool.query(
        `UPDATE videos SET status='completed',error_message='' WHERE id=$1 AND user_id=$2 AND status='indexing' AND transcript IS NOT DISTINCT FROM $3 AND NULLIF(file,'') IS NOT DISTINCT FROM NULLIF($4,'') RETURNING id`,
        [videoId, source.user_id, source.transcript, source.file],
      );
      if (!updated.rowCount) {
        const current = await pool.query<{ status: string }>('SELECT status FROM videos WHERE id=$1 AND user_id=$2', [videoId, source.user_id]);
        if (current.rows[0]?.status === 'indexing') throw new Error('Video changed before indexing completion; retry');
      }
    }
    return result;
  } finally { if (ownPool) await pool.end(); }
}
