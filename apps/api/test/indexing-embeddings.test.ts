import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedTexts } from '../src/lib/embeddings';
const vector = (dimensions: number) => [1, ...Array(dimensions - 1).fill(0)];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('LangChain document embeddings for on-premises indexing', () => {
  it.each([768,1536])('keeps batching, order, literal newlines and model prefixes (%i)', async dimensions => {
    const calls: { input: string[]; dimensions?: number; encoding_format: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      expect(request.url).toBe('http://embeddings.test/v1/embeddings');
      expect(request.headers.get('authorization')).toBe('Bearer private-key');
      const body = await request.json(); calls.push(body);
      return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: vector(dimensions) })) });
    }));
    const texts = Array.from({length:33},(_,i)=>`字幕${i}\n次の行`);
    const env = { EMBEDDING_BASE_URL:'http://embeddings.test/v1',EMBEDDING_API_KEY:'private-key',
      ...(dimensions===768?{EMBEDDING_PROFILE:'embeddinggemma2',EMBEDDING_MODEL:'private-gemma'}:{}) };
    expect(await embedTexts(env,texts,'document')).toEqual(texts.map(()=>vector(dimensions)));
    expect(calls.map(c=>c.input.length)).toEqual([32,1]);
    expect(calls[0].input[0]).toBe((dimensions===768?'title: none | text: ':'')+texts[0]);
    expect(calls[0].dimensions).toBe(dimensions===768?undefined:1536);
    expect(calls[0].encoding_format).toBe('float');
  });
  it('rejects provider row/index drift and wrong dimensions', async () => {
    for (const data of [[{index:1,embedding:vector(1536)}],[{index:0,embedding:[1]}],[]]) {
      vi.stubGlobal('fetch', vi.fn(async()=>Response.json({data})));
      await expect(embedTexts({OPENAI_API_KEY:'test'},['caption'],'document')).rejects.toMatchObject({reason:'EMBEDDING_OUTPUT_INVALID'});
    }
  });
  it('avoids provider work for empty or cancelled requests', async () => {
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    expect(await embedTexts({},[],'document')).toEqual([]);
    await expect(embedTexts({OPENAI_API_KEY:'test'},['caption'],'document',AbortSignal.abort())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
