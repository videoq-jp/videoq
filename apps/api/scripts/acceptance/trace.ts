import { AsyncLocalStorage } from 'node:async_hooks';
import {createHash} from 'node:crypto';
export type Trace = { stages: Record<string, number[]>; reads: number; writes: number; queries: number; unavailableReadMetadata?:number;
 sql?:Record<string,{calls:number;elapsedMs:number;rowsRead:number;rowsWritten:number;metadataUnavailable:number}>;
 phase?:'authentication'|'retrieval'; firstAnswerMs?: number; completeMs?: number };
export const traces = new AsyncLocalStorage<Trace>();
export async function timed<T>(stage: string, action: () => Promise<T>): Promise<T> {
 const start = performance.now();
 try { return await action(); }
 finally { const trace = traces.getStore(); if (trace) (trace.stages[stage] ??= []).push(performance.now() - start); }
}
/** Preserves native raw/first semantics; unavailable metadata is never reported as zero total reads. */
export function measuredD1(database: D1Database): D1Database {
 const statement = (value: D1PreparedStatement,sql:string): D1PreparedStatement => new Proxy(value, { get(target, key) {
  if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args),sql);
  if (['all', 'run', 'first', 'raw'].includes(String(key))) return (...args: unknown[]) => {
   const trace=traces.getStore(),start=performance.now();
   return timed(trace?.phase==='authentication'?'d1_authentication':'d1_hydration', async () => {
    const method=Reflect.get(target,key) as (...values:unknown[])=>Promise<unknown>;
    const result=await method.apply(target,args);
    const metadata=typeof result==='object' && result!==null && 'meta' in result ? result.meta as {rows_read?:number;rows_written?:number} : undefined;
    if(trace) {
     trace.queries++;
     const known=metadata?.rows_read!==undefined;
     if(!known) trace.unavailableReadMetadata=(trace.unavailableReadMetadata??0)+1;
     trace.reads+=metadata?.rows_read??0;trace.writes+=metadata?.rows_written??0;
     const id=createHash('sha256').update(sql).digest('hex');trace.sql??={};
     const operation=trace.sql[id]??={calls:0,elapsedMs:0,rowsRead:0,rowsWritten:0,metadataUnavailable:0};
     operation.calls++;operation.elapsedMs+=performance.now()-start;operation.rowsRead+=metadata?.rows_read??0;operation.rowsWritten+=metadata?.rows_written??0;if(!known)operation.metadataUnavailable++;
    }
    return result;
   });
  };
  const property:unknown=Reflect.get(target,key);return typeof property==='function'?(property as (...values:unknown[])=>unknown).bind(target):property;
 }});
 return new Proxy(database,{get(target,key){if(key==='prepare')return(sql:string)=>statement(target.prepare(sql),sql);const property:unknown=Reflect.get(target,key);return typeof property==='function'?(property as (...values:unknown[])=>unknown).bind(target):property;}});
}
