import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {handleEdgeBenchmark} from '../../scripts/migrations/d1/edge-benchmark-http';
import {validateTokyoBenchmarkTarget} from '../../scripts/migrations/d1/edge-benchmark-tokyo-target';
import {validateEdgeBenchmarkTarget} from '../../scripts/migrations/d1/edge-benchmark-target';
const secret='a'.repeat(64),input={version:1,cases:[{videoId:1,userId:'owner'}],samples:1};
function request(body:unknown=input,authorization='Bearer '+secret){return new Request('https://private.test/measure',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body)});}
describe('private placed HTTP measurement capability',()=>{
 it.each(['','Bearer '+('b'.repeat(64)),'Bearer '+('é'.repeat(64))])('rejects an invalid capability before reading input',async authorization=>{
  const measure=vi.fn(),r=request(input,authorization),read=vi.spyOn(r.body!,'getReader');
  expect((await handleEdgeBenchmark(r,secret,measure)).status).toBe(401);
  expect(read).not.toHaveBeenCalled();expect(measure).not.toHaveBeenCalled();
 });
 it('fails closed if the capability has not been configured',async()=>{
  const measure=vi.fn();expect((await handleEdgeBenchmark(request(),undefined,measure)).status).toBe(503);expect(measure).not.toHaveBeenCalled();
 });
 it('accepts only the bounded measurement contract',async()=>{
  const measure=vi.fn(async()=>({paired_reads:1}));const response=await handleEdgeBenchmark(request(),secret,measure);
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({paired_reads:1});expect(measure).toHaveBeenCalledWith(input);
 });
 it('rejects oversize streamed bodies even without content-length',async()=>{
  const measure=vi.fn();expect((await handleEdgeBenchmark(request('x'.repeat(17000)),secret,measure)).status).toBe(413);expect(measure).not.toHaveBeenCalled();
 });
 it('rejects arbitrary SQL and oversized read counts',async()=>{
  for(const body of [{...input,sql:'DELETE'}, {...input,samples:26}]){
   const measure=vi.fn();expect((await handleEdgeBenchmark(request(body),secret,measure)).status).toBe(400);expect(measure).not.toHaveBeenCalled();
  }
 });
 it('does not expose raw backend errors',async()=>{
  const response=await handleEdgeBenchmark(request(),secret,async()=>{throw new Error('private-database-secret');});
  expect(response.status).toBe(502);expect(await response.text()).not.toContain('private-database-secret');
 });
 it('pins placement and rejects the unplaced baseline and public routes',()=>{
  const text=readFileSync(new URL('../../wrangler.d1-edge-benchmark-tokyo.jsonc',import.meta.url),'utf8'),config=validateTokyoBenchmarkTarget(text);
  expect(config.placement.region).toBe('aws:ap-northeast-1');
  expect(()=>validateEdgeBenchmarkTarget(text)).toThrow();
  expect(()=>validateTokyoBenchmarkTarget(JSON.stringify({...config,workers_dev:true}))).toThrow();
  expect(()=>validateTokyoBenchmarkTarget(JSON.stringify({...config,placement:{region:'aws:us-east-1'}}))).toThrow();
 });
});
