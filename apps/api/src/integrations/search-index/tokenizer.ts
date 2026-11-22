import { Buffer } from 'node:buffer';
import { Tiktoken, getEncodingNameForModel, type TiktokenBPE, type TiktokenModel } from 'js-tiktoken/lite';
import type { SceneEncoding } from '../../application/search-scene-splitting';

/** Use the published rank data for strict decoding rather than library internals. */
export function sceneEncoding(ranks: TiktokenBPE): SceneEncoding {
  const tokenizer = new Tiktoken(ranks);
  let bytesByToken: Map<number, Uint8Array> | undefined;
  return {
    encode: text => tokenizer.encode(text, [], []),
    decodeStrict(tokens) {
      if (!bytesByToken) {
        bytesByToken = new Map();
        for (const line of ranks.bpe_ranks.split('\n').filter(Boolean)) {
          const [, offset, ...tokens] = line.split(' ');
          for (const [i, token] of tokens.entries()) bytesByToken.set(Number(offset) + i, Buffer.from(token, 'base64'));
        }
      }
      const chunks = tokens.map(token => {
        const bytes = bytesByToken!.get(token);
        if (!bytes) throw new Error('Unknown ordinary token');
        return bytes;
      });
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    },
  };
}

export async function createSceneEncoding(model: string, provider: string): Promise<SceneEncoding> {
  let name = 'cl100k_base';
  if (provider === 'openai') {
    try { name = getEncodingNameForModel(model as TiktokenModel); } catch { /* Match Python's fallback for unknown provider models. */ }
  }
  switch (name) {
    case 'o200k_base': return sceneEncoding((await import('js-tiktoken/ranks/o200k_base')).default);
    case 'p50k_base': return sceneEncoding((await import('js-tiktoken/ranks/p50k_base')).default);
    case 'p50k_edit': return sceneEncoding((await import('js-tiktoken/ranks/p50k_edit')).default);
    case 'r50k_base':
    case 'gpt2': return sceneEncoding((await import('js-tiktoken/ranks/r50k_base')).default);
    default: return sceneEncoding((await import('js-tiktoken/ranks/cl100k_base')).default);
  }
}
