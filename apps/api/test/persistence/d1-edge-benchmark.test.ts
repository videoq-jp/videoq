import {describe,expect,it,vi} from 'vitest';
import {measureEdgeReads} from '../../scripts/migrations/d1/edge-benchmark';

const request={version:1,cases:[{videoId:1,userId:'private-owner-canary'}],samples:2};
describe('same Worker database read measurement',()=>{
 it('alternates order and returns only timings and aggregate counts',async()=>{
  const order:string[]=[];let clock=0;
  const report=await measureEdgeReads({postgres:async()=>{order.push('postgres');return true;},d1:async()=>{order.push('d1');return true;}},request,()=>clock++);
  expect(order).toEqual(['postgres','d1','d1','postgres']);
  expect(report.paired_reads).toBe(2);
  expect(report.durations_ms).toEqual({postgres:[1,1],d1:[1,1]});
  expect(JSON.stringify(report)).not.toContain('private-owner-canary');
  expect(report.acceptance_criteria_applied).toBe(false);
  expect(report.api_e2e_measured).toBe(false);
 });
 it.each([false,true])('rejects missing or different owned rows (D1=%s)',async d1=>{
  await expect(measureEdgeReads({postgres:async()=>false,d1:async()=>d1},request)).rejects.toThrow('BENCHMARK_OWNED_ROW_DOES_NOT_MATCH');
 });
 it.each([
  {...request,samples:26}, {...request,cases:[]},
  {...request,cases:[request.cases[0],request.cases[0]],samples:13},
  {...request,cases:[{videoId:1,userId:'x',sql:'unsafe'}]},
  {...request,sql:'unsafe'}, {...request,cases:[{videoId:Number.MAX_SAFE_INTEGER+1,userId:'x'}]},
 ])('rejects invalid input before accessing either backend',async input=>{
  const read=vi.fn(async()=>true);
  await expect(measureEdgeReads({postgres:read,d1:read},input)).rejects.toThrow('INVALID_EDGE_BENCHMARK_INPUT');
  expect(read).not.toHaveBeenCalled();
 });
 it('does not run the second backend after the first read fails',async()=>{
  const d1=vi.fn(async()=>true);
  await expect(measureEdgeReads({postgres:async()=>{throw new Error('unavailable');},d1},request)).rejects.toThrow('unavailable');
  expect(d1).not.toHaveBeenCalled();
 });
 it('rejects invalid timing samples',async()=>{
  await expect(measureEdgeReads({postgres:async()=>true,d1:async()=>true},request,()=>NaN)).rejects.toThrow('INVALID_BENCHMARK_CLOCK');
 });
});
