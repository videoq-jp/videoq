import {describe,it,expect,vi} from 'vitest';
import type {D1Database} from '@cloudflare/workers-types';
import {readFileSync} from 'node:fs';
import {bookmarkedReplicaSession} from '../../scripts/migrations/d1/edge-replica-session';
import {validateReplicaBenchmarkTarget} from '../../scripts/migrations/d1/edge-benchmark-replica-target';
import {validateTokyoBenchmarkTarget} from '../../scripts/migrations/d1/edge-benchmark-tokyo-target';
const input={version:1 as const,cases:[{videoId:7,userId:'owner'}],samples:1};
function fixture(rows={results:[{id:7}]},bookmark:string|null='private-bookmark'){
 const bind=vi.fn(()=>({bound:true})),primary={prepare:vi.fn(()=>({bind})),batch:vi.fn(async()=>[rows]),getBookmark:vi.fn(()=>bookmark)},replica={replica:true};
 const withSession=vi.fn((constraint:string)=>constraint==='first-primary'?primary:replica);
 return {database:{withSession} as unknown as Pick<D1Database,'withSession'>,withSession,primary,replica,bind};
}
describe('primary authorization followed by constrained replica reads',()=>{
 it('checks the exact owner on primary and seeds the replica with its bookmark',async()=>{
  const f=fixture();let clock=10;const result=await bookmarkedReplicaSession(f.database,input,()=>clock++);
  expect(f.withSession.mock.calls).toEqual([['first-primary'],['private-bookmark']]);
  expect(f.primary.prepare).toHaveBeenCalledWith('SELECT id FROM videos WHERE id=? AND user_id=?');
  expect(f.bind).toHaveBeenCalledWith(7,'owner');expect(result.session).toBe(f.replica);expect(result.primaryAuthorizationMs).toBe(1);
 });
 it.each([{results:[]},{results:[{id:8}]},{results:[{id:7},{id:7}]}])('refuses missing or different primary ownership',async rows=>{
  const f=fixture(rows);await expect(bookmarkedReplicaSession(f.database,input)).rejects.toThrow('PRIMARY_OWNERSHIP_REQUIRED');expect(f.withSession).toHaveBeenCalledTimes(1);
 });
 it('does not silently fall back to unconstrained reads when the bookmark is missing',async()=>{
  const f=fixture(undefined,null);await expect(bookmarkedReplicaSession(f.database,input)).rejects.toThrow('PRIMARY_AUTHORIZATION_BOOKMARK_REQUIRED');expect(f.withSession).toHaveBeenCalledTimes(1);
 });
 it('does not reuse authorization across invocations',async()=>{
  const f=fixture();await bookmarkedReplicaSession(f.database,input);f.primary.batch.mockResolvedValueOnce([{results:[]}]);
  await expect(bookmarkedReplicaSession(f.database,input)).rejects.toThrow('PRIMARY_OWNERSHIP_REQUIRED');
  expect(f.withSession.mock.calls.filter(([constraint])=>constraint==='first-primary')).toHaveLength(2);
 });
 it('pins the separate private replica benchmark target',()=>{
  const text=readFileSync(new URL('../../wrangler.d1-edge-benchmark-replica.jsonc',import.meta.url),'utf8');
  expect(validateReplicaBenchmarkTarget(text).placement.region).toBe('aws:ap-northeast-1');expect(()=>validateTokyoBenchmarkTarget(text)).toThrow();
 });
});
