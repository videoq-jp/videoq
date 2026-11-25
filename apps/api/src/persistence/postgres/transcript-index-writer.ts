import { SafeJobError } from '../../application/job-failure';
import pg from 'pg';
import { PGEngine, PGVectorStore } from '@yukiharada1228/langchain-postgres';
import type { SearchScene } from '../../application/search-scene-splitting';

export interface PostgresTranscriptSnapshot {
  videoId: number;
  userId: string;
  transcript: string;
}
export interface TranscriptVectorStorage {
  table: 'scene_embeddings' | 'scene_embeddings_768';
  dimensions: 768 | 1536;
  fingerprint?: string;
  identity?: string;
  /** Explicit schema is useful for isolated integration tests. */
  schema?: string;
}
const quote = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';

/**
 * PGVectorStore 0.2.x acquires its own client. Restrict its private engine to the
 * client's current transaction; library release() must not release our lease.
 * Never expose this engine to code outside the transaction callback.
 */
function transactionEngine(pool: pg.Pool, client: pg.PoolClient): PGEngine {
  const pinnedClient = new Proxy(client, {
    get(target, key) {
      if (key === 'release') return () => {};
      if (key === 'query') return target.query.bind(target);
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
  const pinnedPool = new Proxy(pool, {
    get(target, key) {
      if (key === 'connect') return () => Promise.resolve(pinnedClient);
      if (key === 'query') return client.query.bind(client);
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
  return PGEngine.fromPool(pinnedPool);
}

export async function validateTranscriptVectorStorage(pool: pg.Pool, storage: TranscriptVectorStorage): Promise<void> {
  if (!['scene_embeddings', 'scene_embeddings_768'].includes(storage.table) ||
      storage.dimensions !== (storage.table === 'scene_embeddings_768' ? 768 : 1536)) throw new Error('Embedding storage profile mismatch');
  const schema = storage.schema ?? 'public';
  const { rows } = await pool.query<{ type: string }>(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a
     JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname=$2 AND a.attname='embedding' AND NOT a.attisdropped`,
    [schema, storage.table],
  );
  if (rows[0]?.type !== `vector(${storage.dimensions})`) throw new Error('Embedding storage dimensions mismatch');
}

/** Old scenes remain visible until every replacement vector commits. */
export async function replacePostgresTranscriptIndex(
  pool: pg.Pool, storage: TranscriptVectorStorage, snapshot: PostgresTranscriptSnapshot,
  scenes: readonly SearchScene[], vectors: number[][],
): Promise<number> {
  await validateTranscriptVectorStorage(pool, storage);
  if (vectors.length !== scenes.length || vectors.some(v => v.length !== storage.dimensions ||
      v.some(x => !Number.isFinite(x) || !Number.isFinite(Math.fround(x))) || !v.some(x => Math.fround(x) !== 0))) {
    throw new Error('Invalid scene embeddings');
  }
  const schema = quote(storage.schema ?? 'public');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ title: string; matches: boolean }>(
      `SELECT title, transcript IS NOT DISTINCT FROM $1 AS matches FROM ${schema}.videos WHERE id=$2 AND user_id=$3 FOR UPDATE`,
      [snapshot.transcript, snapshot.videoId, snapshot.userId],
    );
    if (!rows.length) { await client.query('ROLLBACK'); return 0; }
    if (!rows[0].matches) throw new SafeJobError('INDEX_SOURCE_CHANGED', true, 'Video transcript changed during indexing; retry');
    const store = await PGVectorStore.initialize(transactionEngine(pool, client), {
      embedQuery: () => Promise.reject(new Error('Use precomputed embeddings')),
      embedDocuments: () => Promise.reject(new Error('Use precomputed embeddings')),
    }, storage.table, { schemaName: storage.schema ?? 'public', metadataColumns: ['user_id', 'video_id'] });
    await client.query(`DELETE FROM ${schema}.${quote(storage.table)} WHERE video_id=$1`, [snapshot.videoId]);
    await store.addVectors(vectors, scenes.map(scene => ({
      pageContent: scene.text,
      metadata: {
        ...(storage.fingerprint ? { embedding_fingerprint: storage.fingerprint, embedding_identity: storage.identity } : {}),
        user_id: snapshot.userId, video_id: snapshot.videoId, video_title: rows[0].title,
        start_time: scene.startTime, end_time: scene.endTime, start_sec: scene.startSeconds, end_sec: scene.endSeconds, scene_index: scene.index,
      },
    })));
    await client.query('COMMIT');
    return scenes.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Explicit subtitle clearing removes both model profiles under the same snapshot lock. */
export async function clearPostgresTranscriptIndex(pool: pg.Pool, snapshot: PostgresTranscriptSnapshot): Promise<number> {
  if (snapshot.transcript.trim()) throw new Error('Only empty transcripts can clear the index');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ matches: boolean }>('SELECT coalesce(transcript,\'\')=$1 AS matches FROM videos WHERE id=$2 AND user_id=$3 FOR UPDATE', [snapshot.transcript, snapshot.videoId, snapshot.userId]);
    if (!rows.length) { await client.query('ROLLBACK'); return 0; }
    if (!rows[0].matches) throw new SafeJobError('INDEX_SOURCE_CHANGED', true, 'Video transcript changed during clearing; retry');
    let count = 0;
    for (const table of ['scene_embeddings','scene_embeddings_768']) {
      count += (await client.query(`DELETE FROM ${quote(table)} WHERE video_id=$1`, [snapshot.videoId])).rowCount ?? 0;
    }
    await client.query('COMMIT');
    return count;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
