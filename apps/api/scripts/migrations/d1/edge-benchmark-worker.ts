import {WorkerEntrypoint} from 'cloudflare:workers';
import pg from 'pg';
import type {Bindings} from '../../../src/types/bindings';
import {edgeBenchmarkInput,measureEdgeReads} from './edge-benchmark';
type BenchmarkBindings=Pick<Bindings,'DB'|'HYPERDRIVE'>;
/** RPC only: ordinary HTTP requests always receive 404, even if a route is
 * accidentally attached outside the reviewed nonpublic benchmark config. */
export class MigrationBenchmark extends WorkerEntrypoint<BenchmarkBindings>{
 async measure(raw:unknown){
  const parsed=edgeBenchmarkInput.safeParse(raw);if(!parsed.success)throw new Error('INVALID_EDGE_BENCHMARK_INPUT');
  const database=this.env.DB,hyperdrive=this.env.HYPERDRIVE;if(!database||!hyperdrive)throw new Error('BENCHMARK_BINDINGS_REQUIRED');
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
 fetch(){return new Response('Not found',{status:404});}
}
export default {fetch(){return new Response('Not found',{status:404});}};
