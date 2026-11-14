import {WorkerEntrypoint} from 'cloudflare:workers';
import pg from 'pg';
import type {Bindings} from '../../../src/types/bindings';
import {edgeBenchmarkInput,measureEdgeReads} from './edge-benchmark';
export type BenchmarkBindings=Pick<Bindings,'DB'|'HYPERDRIVE'>;
/** Fixed read-only workload shared by the private benchmark entrypoints. */
export async function measureEdgeDatabases(env:BenchmarkBindings,raw:unknown){
  const parsed=edgeBenchmarkInput.safeParse(raw);if(!parsed.success)throw new Error('INVALID_EDGE_BENCHMARK_INPUT');
  const database=env.DB,hyperdrive=env.HYPERDRIVE;if(!database||!hyperdrive)throw new Error('BENCHMARK_BINDINGS_REQUIRED');
  const client=new pg.Client({connectionString:hyperdrive.connectionString,connectionTimeoutMillis:10000,query_timeout:5000});let connected=false,unavailable=false;
  client.on('error',()=>{unavailable=true;});
  try{
   const start=performance.now();await client.connect();connected=true;
   await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='2s'");
   const readOnly=(await client.query<{readonly:string}>("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly;if(readOnly!=='on')throw new Error('READONLY_REQUIRED');
   const setup=performance.now()-start;
   const result=await measureEdgeReads({
    postgres:async request=>{if(unavailable)throw new Error('POSTGRES_UNAVAILABLE');return (await client.query('SELECT id FROM videos WHERE id=$1 AND user_id=$2',[request.videoId,request.userId])).rows.length===1;},
    d1:async request=>Boolean(await database.prepare('SELECT id FROM videos WHERE id=? AND user_id=?').bind(request.videoId,request.userId).first()),
   },parsed.data);
   return {...result,postgres_connection_and_readonly_setup_ms:setup,postgres_readonly_verified:true};
  }catch{throw new Error('EDGE_DATABASE_READ_BENCHMARK_FAILED');}
  finally{if(connected)await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}
}
/** The baseline RPC entrypoint and its default HTTP handler always refuse fetch. */
export class MigrationBenchmark extends WorkerEntrypoint<BenchmarkBindings>{
 measure(raw:unknown){return measureEdgeDatabases(this.env,raw);}
 fetch(){return new Response('Not found',{status:404});}
}
export default {fetch(){return new Response('Not found',{status:404});}};
