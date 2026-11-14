import {describe,it,expect,vi} from 'vitest';
import {evaluatePairedSceneSearch,validateSearchEvaluationInput,type SearchEvaluationInput} from '../../scripts/migrations/d1/search-evaluation';
import type {SceneHit} from '../../src/persistence/contracts/scene-search';
const hit = (content: string,videoId=1): SceneHit => ({content,videoId,videoTitle:'Synthetic title',startTime:'00:01',endTime:'00:02'});
const input = (): SearchEvaluationInput => ({version:1,cohort:'synthetic',corpusSha256:'a'.repeat(64),model:'synthetic-model',dimensions:768,samples:1,
 cases:[{queryEmbedding:Array.from({length:768},(_,i)=>i===0?1:0),userId:'synthetic-owner',videoIds:[1],limit:3}]});

describe('paired scene search evaluation',()=>{
 it('uses identical precomputed requests with isolated copies and alternates backend order',async()=>{
  const order: string[]=[],requests: unknown[]=[];
  const postgres={search:vi.fn(async request=>{order.push('pg');requests.push(structuredClone(request));request.queryEmbedding[0]=99;request.videoIds.push(9);return [hit('a')];})};
  const d1={search:vi.fn(async request=>{order.push('d1');requests.push(structuredClone(request));return [hit('a')];})};
  const source=input();source.samples=2;
  const report=await evaluatePairedSceneSearch({postgres,d1},source);
  expect(order).toEqual(['pg','d1','d1','pg']);
  expect(requests.every(request=>JSON.stringify(request)===JSON.stringify(source.cases[0]))).toBe(true);
  expect(report.agreement.mean_reference_top_k_overlap).toBe(1);
  expect(report.agreement.exact_rank_order_pairs).toBe(2);
  expect(report.latency.postgres.samples).toBe(2);
  expect(report.latency.d1.p99_ms).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(report)).not.toContain('synthetic-owner');
  expect(JSON.stringify(report)).not.toContain('Synthetic title');
  expect(report.acceptance_criteria_applied).toBe(false);
  expect(report.execution_complete).toBe(false);
 });
 it('counts multiset overlap without inflating duplicate matches and distinguishes ordering',async()=>{
  const report=await evaluatePairedSceneSearch({postgres:{search:async()=>[hit('a'),hit('a'),hit('b')]},d1:{search:async()=>[hit('b'),hit('a')]}},input());
  expect(report.agreement.mean_reference_top_k_overlap).toBeCloseTo(2/3);
  expect(report.agreement.overlapping_hits).toBe(2);
  expect(report.agreement.exact_rank_order_pairs).toBe(0);
 });
 it('does not treat empty references as perfect recall or hide missing candidates',async()=>{
  const source=input();source.samples=3;
  let pg=0,d1=0;
  const report=await evaluatePairedSceneSearch({postgres:{search:async()=>++pg===3?[hit('a')]:[]},d1:{search:async()=>++d1===2?[hit('a')]:[]}},source);
  expect(report.agreement).toMatchObject({reference_empty_pairs:2,both_empty_pairs:1,candidate_nonempty_when_reference_empty:1,reference_nonempty_pairs:1,mean_reference_top_k_overlap:0});
  const empty=await evaluatePairedSceneSearch({postgres:{search:async()=>[]},d1:{search:async()=>[]}},input());
  expect(empty.agreement.mean_reference_top_k_overlap).toBeNull();
 });
 it('ignores titles but distinguishes content, timestamps and evidence type',async()=>{
  const report=await evaluatePairedSceneSearch({postgres:{search:async()=>[hit('a')]},d1:{search:async()=>[{...hit('a'),videoTitle:'Current title',evidenceType:'transcript'}]}},input());
  expect(report.agreement.mean_reference_top_k_overlap).toBe(1);
  const changed=await evaluatePairedSceneSearch({postgres:{search:async()=>[hit('a')]},d1:{search:async()=>[{...hit('a'),evidenceType:'visual'}]}},input());
  expect(changed.agreement.mean_reference_top_k_overlap).toBe(0);
 });
 it('rejects invalid profiles, requests and scopes before performing any query',async()=>{
  const search=vi.fn();
  for(const mutate of [(value:SearchEvaluationInput)=>{value.samples=0;},(value:SearchEvaluationInput)=>{value.cases[0].queryEmbedding=[1];},
   (value:SearchEvaluationInput)=>{value.cases[0].videoIds=[];},(value:SearchEvaluationInput)=>{value.cases[0].queryEmbedding[0]=Infinity;},
   (value:SearchEvaluationInput)=>{value.corpusSha256='database-name';}]){
   const value=input();mutate(value);await expect(evaluatePairedSceneSearch({postgres:{search},d1:{search}},value)).rejects.toThrow();
  }
  expect(search).not.toHaveBeenCalled();
  expect(()=>validateSearchEvaluationInput(null)).toThrow();
 });
 it('rejects out-of-scope or over-limit results, and never turns query errors into empty success',async()=>{
  await expect(evaluatePairedSceneSearch({postgres:{search:async()=>[hit('a',2)]},d1:{search:async()=>[]}},input())).rejects.toThrow('scope');
  await expect(evaluatePairedSceneSearch({postgres:{search:async()=>Array(4).fill(hit('a'))},d1:{search:async()=>[]}},input())).rejects.toThrow('contract');
  await expect(evaluatePairedSceneSearch({postgres:{search:async()=>{throw new Error('synthetic failure');}},d1:{search:async()=>[]}},input())).rejects.toThrow('synthetic failure');
 });
 it('honors cancellation before performing queries',async()=>{
  const search=vi.fn(),controller=new AbortController();controller.abort();
  await expect(evaluatePairedSceneSearch({postgres:{search},d1:{search}},input(),controller.signal)).rejects.toThrow();
  expect(search).not.toHaveBeenCalled();
 });
});
