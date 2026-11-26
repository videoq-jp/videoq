import pg from 'pg';
import { embeddingDimensions, embeddingFingerprint, embeddingIdentity, embeddingTable, resolveEmbeddingConfig, type EmbeddingSettings } from '../../src/lib/embedding-contract';
import { replacePostgresTranscriptIndex } from '../../src/persistence/postgres/transcript-index-writer';

/** Seed search fixtures through the production writer, including its provenance. */
export async function seedPostgresSceneIndex(
  connectionString: string, videoId: number,
  scenes: { text: string; vector: number[]; startTime?: string; endTime?: string }[],
  settings: EmbeddingSettings = {},
): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query('SELECT user_id, transcript FROM videos WHERE id=$1', [videoId]);
    if (rows.length !== 1) throw new Error('Missing scene fixture video');
    const config = resolveEmbeddingConfig(settings);
    const seconds = (time: string) => time.split(':').reduce((total, part) => total * 60 + Number(part.replace(',', '.')), 0);
    const count = await replacePostgresTranscriptIndex(pool, {
      table: embeddingTable(config), dimensions: embeddingDimensions(config) as 768 | 1536,
      fingerprint: await embeddingFingerprint(config), identity: embeddingIdentity(config),
    }, { videoId, userId: rows[0].user_id, transcript: rows[0].transcript }, scenes.map((scene, index) => {
      const startTime = scene.startTime ?? '00:00:00', endTime = scene.endTime ?? '00:00:10';
      return { index, text: scene.text, startTime, endTime, startSeconds: seconds(startTime), endSeconds: seconds(endTime) };
    }), scenes.map(scene => scene.vector));
    if (count !== scenes.length) throw new Error('Scene fixture writer did not publish every vector');
  } finally { await pool.end(); }
}
