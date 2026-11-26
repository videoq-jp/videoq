import { splitSearchScenes } from '../../application/scene-splitting';
import { embedTexts, type EmbeddingEnv } from '../../lib/embeddings';
import { EmbeddingValidationError, resolveEmbeddingConfig } from '../../lib/embedding-contract';
import { LlmConfigurationError } from '../../lib/openai';
import { createSceneEncoding } from './tokenizer';

export async function splitTranscriptForIndex(env: EmbeddingEnv, transcript: string, signal?: AbortSignal, checkpointEmbeddings?: (texts: string[]) => Promise<number[][]>, checkpointBoundary?: (start: number, end: number, texts: string[]) => Promise<number>): Promise<string> {
  const config = resolveEmbeddingConfig(env);
  const encoding = await createSceneEncoding(config.model, config.provider ?? 'openai');
  try {
    return await splitSearchScenes(transcript, {
      encoding, boundary: checkpointBoundary,
      embed: async texts => {
        if (checkpointEmbeddings) return checkpointEmbeddings(texts);
        const vectors: number[][] = [];
        for (let offset = 0; offset < texts.length; offset += 16) {
          vectors.push(...await embedTexts(env, texts.slice(offset, offset + 16), 'document', signal));
        }
        return vectors;
      },
    });
  } catch (error) {
    signal?.throwIfAborted();
    // Durable model steps own their retries. Do not turn a lost checkpoint or
    // missing saved batch into a successful fallback with different boundaries.
    if (checkpointEmbeddings) throw error;
    if (error instanceof EmbeddingValidationError || error instanceof LlmConfigurationError) throw error;
    // Preserve the existing best-effort scene grouping policy. Index embeddings
    // are generated separately and still fail the job on provider failures.
    console.warn(JSON.stringify({ event: 'scene_splitting_fallback' }));
    return transcript;
  }
}
