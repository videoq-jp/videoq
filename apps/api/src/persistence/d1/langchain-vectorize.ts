import type { Vectorize, VectorizeIndex } from "@cloudflare/workers-types";

/**
 * LangChain 1.1 still declares the beta binding type and requests boolean
 * metadata. Its implementation only awaits mutation calls (it does not inspect
 * beta mutation results), so V2's asynchronous acknowledgements can pass through.
 * Keep that type boundary here and normalize query options to the V2 API.
 */
export function langchainVectorizeBinding(index: Vectorize): VectorizeIndex {
  const bridge: Vectorize = {
    describe: () => index.describe(),
    insert: vectors => index.insert(vectors),
    upsert: vectors => index.upsert(vectors),
    deleteByIds: ids => index.deleteByIds(ids),
    getByIds: ids => index.getByIds(ids),
    queryById: (id, options) => index.queryById(id, options),
    async query(vector, options) {
      const metadata = options?.returnMetadata;
      const result = await index.query(vector, { ...options,
        returnMetadata: metadata === true ? "all" : metadata === false ? "none" : metadata,
        returnValues: false,
      });
      return { ...result, matches: result.matches.map(match => ({ ...match,
        // Pin the physical result ID, rather than trusting a metadata copy of it.
        metadata: { ...match.metadata, vector_id: match.id },
      })) };
    },
  };
  return bridge as unknown as VectorizeIndex;
}
