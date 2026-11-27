import { describe,expect,it } from 'vitest';
import { otsuBoundary } from '../src/domain/search/search-scene-splitting';
import { streamingOtsuBoundary,type OtsuCheckpoint } from '../src/application/streaming-otsu';
describe('bounded-memory durable Otsu kernel',()=>{
  it.each([[0,120],[5,88],[16,33],[9,10]])('matches the in-memory kernel for range %i..%i',async(start,end)=>{
    const vectors=Array.from({length:121},(_,i)=>[Math.sin(i),Math.cos(i),i%7]);
    const normalized=vectors.map(v=>{const norm=Math.max(Math.sqrt(v.reduce((s,x)=>s+x*x,0)),1e-12);return v.map(x=>x/norm);});
    const result=await streamingOtsuBoundary(start,end,{dimensions:3,batchSize:16,batchesPerStep:2,
      readBatch:async offset=>vectors.slice(offset,offset+16),checkpoint:async(_name,operation)=>operation()});
    expect(result).toBe(otsuBoundary(normalized,start,end));
  });
  it('preserves the first boundary on ties',async()=>{
    expect(await streamingOtsuBoundary(0,100,{dimensions:3,batchSize:16,batchesPerStep:2,
      readBatch:async()=>Array.from({length:16},()=>[1,0,0]),checkpoint:async(_name,operation)=>operation()})).toBe(1);
  });
  it('keeps checkpoint results small for thousands of 768-dimensional cues and replays without rereading batches',async()=>{
    const cache=new Map<string,OtsuCheckpoint>();let reads=0,maxBytes=0;
    const deps={dimensions:768,batchSize:16,batchesPerStep:64,
      readBatch:async(offset:number)=>{reads++;return Array.from({length:16},(_,i)=>Array.from({length:768},(_,d)=>d===0?1:(offset+i)%7/1000));},
      checkpoint:async(name:string,operation:()=>Promise<OtsuCheckpoint>)=>{
        if(cache.has(name))return structuredClone(cache.get(name)!);
        const value=await operation();maxBytes=Math.max(maxBytes,JSON.stringify(value).length);cache.set(name,structuredClone(value));return value;
      }};
    const first=await streamingOtsuBoundary(0,4999,deps);const initialReads=reads;
    expect(first).toBeGreaterThan(0);expect(first).toBeLessThan(5000);expect(maxBytes).toBeLessThan(25_000);
    expect(await streamingOtsuBoundary(0,4999,deps)).toBe(first);expect(reads).toBe(initialReads);
  });
});
