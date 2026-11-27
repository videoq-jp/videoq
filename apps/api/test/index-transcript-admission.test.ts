import { expect, it, vi } from 'vitest';
import { indexTranscript } from '../src/integrations/search-index/index-transcript';
import type { Bindings } from '../src/types/bindings';
import type pg from 'pg';

it.each(['pending', 'transcribing', 'error'])('refuses %s media before splitting or embedding', async status => {
  const query = vi.fn(async () => ({rows:[{id:1,user_id:'owner',status,transcript:'',file:'source'}]}));
  const env = { PERSISTENCE_BACKEND:'postgres', DEPLOYMENT_EDITION:'onprem', DATABASE_POOL:{query} as unknown as pg.Pool } as Bindings;
  await expect(indexTranscript(env,1,{finishIndexing:true})).rejects.toMatchObject({code:'INDEX_NOT_READY'});
  expect(query).toHaveBeenCalledTimes(1);
});
it('does not reprocess completed media and rejects an empty indexing transcript', async () => {
  const query = vi.fn().mockResolvedValueOnce({rows:[{id:1,user_id:'owner',status:'completed',transcript:'',file:'source'}]})
    .mockResolvedValueOnce({rows:[{id:1,user_id:'owner',status:'indexing',transcript:'',file:'source'}]});
  const env = { PERSISTENCE_BACKEND:'postgres', DEPLOYMENT_EDITION:'onprem', DATABASE_POOL:{query} as unknown as pg.Pool } as Bindings;
  expect(await indexTranscript(env,1,{finishIndexing:true})).toBe(0);
  await expect(indexTranscript(env,1,{finishIndexing:true})).rejects.toMatchObject({code:'INVALID_TRANSCRIPT'});
  expect(query).toHaveBeenCalledTimes(2);
});
