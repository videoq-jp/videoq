import {WorkerEntrypoint} from 'cloudflare:workers';
import pg from 'pg';
import type {Bindings} from '../../../src/types/bindings';
import {edgeBenchmarkInput,measureEdgeReads} from './edge-benchmark';
import {bookmarkedReplicaSession} from './edge-replica-session';
export type BenchmarkBindings=Pick<Bindings,'DB'|'HYPERDRIVE'>;
/** Fixed read-only workload shared by the private benchmark entrypoints. */
export async function measureEdgeDatabases(env:BenchmarkBindings,raw:unknown,d1Mode:'primary'|'bookmarked-replica'='primary'){
  const parsed=edgeBenchmarkInput.safeParse(raw);if(!parsed.success)throw new Error('INVALID_EDGE_BENCHMARK_INPUT');
  const database=env.DB,hyperdrive=env.HYPERDRIVE;if(!database||!hyperdrive)throw new Error('BENCHMARK_BINDINGS_REQUIRED');
  const client=new pg.Client({connectionString:hyperdrive.connectionString,connectionTimeoutMillis:10000,query_timeout:5000});let connected=false,unavailable=false;
  client.on('error',()=>{unavailable=true;});
  try{
   const start=performance.now();await client.connect();connected=true;
   await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='2s'");
   const readOnly=(await client.query<{readonly:string}>("SELECT current_setting('transaction_read_only') AS readonly")).rows[0].readonly;if(readOnly!=='on')throw new Error('READONLY_REQUIRED');
   const setup=performance.now()-start;
   const replica=d1Mode==='bookmarked-replica'?await bookmarkedReplicaSession(database,parsed.data):undefined;
   const reads=replica?.session??database,d1Serving:{region:string|null;primary:boolean|null}[]=[];
   const result=await measureEdgeReads({
    postgres:async request=>{if(unavailable)throw new Error('POSTGRES_UNAVAILABLE');return (await client.query('SELECT id FROM videos WHERE id=$1 AND user_id=$2',[request.videoId,request.userId])).rows.length===1;},
    d1:async request=>{const response=await reads.prepare('SELECT id FROM videos WHERE id=? AND user_id=?').bind(request.videoId,request.userId).all<{id:number}>();const meta=response.meta;d1Serving.push({region:typeof meta.served_by_region==='string'?meta.served_by_region:null,primary:typeof meta.served_by_primary==='boolean'?meta.served_by_primary:null});return response.results.length===1&&response.results[0].id===request.videoId;},
   },parsed.data);
   return {...result,postgres_connection_and_readonly_setup_ms:setup,postgres_readonly_verified:true,d1_read_mode:d1Mode,d1_primary_authorization_ms:replica?.primaryAuthorizationMs??null,d1_serving:d1Serving};
  }catch{throw new Error('EDGE_DATABASE_READ_BENCHMARK_FAILED');}
  finally{if(connected)await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}
}
/** The baseline RPC entrypoint and its default HTTP handler always refuse fetch. */
export class MigrationBenchmark extends WorkerEntrypoint<BenchmarkBindings>{
 measure(raw:unknown){return measureEdgeDatabases(this.env,raw);}
 fetch(){return new Response('Not found',{status:404});}
}
export default {fetch(){return new Response('Not found',{status:404});}};
