/** D1-only supplemental replay. No model calls; historical latency/rows are never rewritten. */
import {createHash} from 'node:crypto';
export type RawResult={success:boolean;meta:{rows_read?:number;rows_written?:number;[key:string]:unknown};results:{columns:string[];rows:unknown[][]}};
export type Query=(sql:string,params:unknown[])=>Promise<RawResult>;
export type ReadObservation={sqlSha256:string;rowsRead:number;rowsWritten:number};
export function replayDatabase(query:Query,observe:(row:ReadObservation)=>void):D1Database {
 const prepare=(sql:string,params:unknown[]=[]):D1PreparedStatement=>{
  const execute=async()=>{const result=await query(sql,params);if(!result.success||!Number.isSafeInteger(result.meta.rows_read)||!Number.isSafeInteger(result.meta.rows_written))throw Error('D1 replay metadata unavailable');
   observe({sqlSha256:createHash('sha256').update(sql).digest('hex'),rowsRead:result.meta.rows_read!,rowsWritten:result.meta.rows_written!});return result;};
  return {bind:(...values:unknown[])=>prepare(sql,values),
   raw:async(options?:{columnNames?:boolean})=>{const result=await execute();return options?.columnNames?[result.results.columns,...result.results.rows]:result.results.rows;},
   first:async(column?:string)=>{const result=await execute();if(!result.results.rows.length)return null;const row=Object.fromEntries(result.results.columns.map((key,i)=>[key,result.results.rows[0][i]]));if(column===undefined)return row;if(!(column in row))throw Error('D1_ERROR: Column not found');return row[column];},
   all:async()=>{const result=await execute();return {...result,results:result.results.rows.map(values=>Object.fromEntries(result.results.columns.map((key,i)=>[key,values[i]])))};},
   run:async()=>{const result=await execute();return {...result,results:result.results.rows.map(values=>Object.fromEntries(result.results.columns.map((key,i)=>[key,values[i]])))};},
  } as D1PreparedStatement;
 };
 return {prepare} as D1Database;
}
