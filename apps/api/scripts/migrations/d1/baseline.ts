import type pg from 'pg';
import {performance} from 'node:perf_hooks';
const identifier=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const milliseconds=(value:number)=>Math.round(value*1000)/1000;
const percentile=(values:number[],fraction:number)=>milliseconds(values[Math.max(0,Math.ceil(values.length*fraction)-1)]);
export type BaselineOptions={schema?:string;samples?:number;statementTimeoutMs?:number};
/** The caller owns the connection. All reads share one read-only MVCC snapshot;
 * physical relation sizes are estimates of storage at observation, not MVCC data.
 * No row contents, SQL text, DSN, usernames, email, tokens or embeddings leave here.
 */
export async function collectPostgresBaseline(client:pg.Client|pg.PoolClient,options:BaselineOptions={}){
 const schema=options.schema??'public',samples=options.samples??30,timeout=options.statementTimeoutMs??60000;
 if(!schema||schema.length>63||schema.includes('\0'))throw new Error('Invalid baseline schema.');
 if(!Number.isSafeInteger(samples)||samples<1||samples>1000)throw new Error('Samples must be between 1 and 1000.');
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)throw new Error('Invalid statement timeout.');
 const collectionStart=performance.now();
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','60000',true)",[String(timeout)]);
  const {rows:[transaction]}=await client.query<{isolation:string;read_only:boolean}>("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only')='on' AS read_only");
  const {rows:catalog}=await client.query<{name:string;relation_bytes:string;table_bytes:string;index_bytes:string;estimated_rows:string}>(`SELECT c.relname AS name,pg_total_relation_size(c.oid)::text AS relation_bytes,pg_table_size(c.oid)::text AS table_bytes,pg_indexes_size(c.oid)::text AS index_bytes,c.reltuples::text AS estimated_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname`,[schema]);
  if(!catalog.length)throw new Error('No source tables found in baseline schema.');
  const tables=[];
  for(const table of catalog){
   const {rows}=await client.query<{rows:string}>(`SELECT count(*)::text AS rows FROM ${identifier(schema)}.${identifier(table.name)}`);
   tables.push({...table,rows:rows[0].rows});
  }
  const {rows:columns}=await client.query<{table:string;column:string;type:string;declared_type:string;identity:string}>(`SELECT c.relname AS "table",a.attname AS "column",t.typname AS type,format_type(a.atttypid,a.atttypmod) AS declared_type,a.attidentity AS identity FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[schema]);
  const vectors=[];
  for(const column of columns.filter(column=>column.type==='vector')){
   // Resolve the extension's schema; never depend on an operator search_path.
   const {rows:extensions}=await client.query<{schema:string}>("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'");
   if(!extensions[0])throw new Error('Vector column exists without pgvector extension.');
   const col=identifier(column.column),table=identifier(schema)+'.'+identifier(column.table),dimensions=identifier(extensions[0].schema)+'.vector_dims';
   const {rows}=await client.query<{dimensions:number|null;rows:string}>(`SELECT ${dimensions}(${col}) AS dimensions,count(*)::text AS rows FROM ${table} GROUP BY ${dimensions}(${col}) ORDER BY dimensions NULLS FIRST`);
   vectors.push({table:column.table,column:column.column,declared_type:column.declared_type,dimensions:rows});
  }
  const integerRanges=[];
  for(const column of columns.filter(column=>column.type==='int8')){
   const col=identifier(column.column),table=identifier(schema)+'.'+identifier(column.table);
   const {rows}=await client.query<{min:string|null;max:string|null;unsafe_rows:string}>(`SELECT min(${col})::text AS min,max(${col})::text AS max,count(*) FILTER(WHERE ${col} NOT BETWEEN -9007199254740991 AND 9007199254740991)::text AS unsafe_rows FROM ${table}`);
   integerRanges.push({table:column.table,column:column.column,...rows[0]});
  }
  // A separate warm round-trip probe; these values are not API E2E latency,
  // cold Neon latency, or production query distribution percentiles.
  await client.query('SELECT 1');const durations=[];
  for(let sample=0;sample<samples;sample++){const start=performance.now();await client.query('SELECT 1');durations.push(performance.now()-start);}
  durations.sort((a,b)=>a-b);
  const {rows:database}=await client.query<{bytes:string}>("SELECT pg_database_size(current_database())::text AS bytes");
  await client.query('COMMIT');
  return {version:1,measured_at:new Date().toISOString(),schema,snapshot:'repeatable-read/read-only',
   database_bytes:database[0].bytes,transaction,tables,columns,vectors,bigint_ranges:integerRanges,
   conversion_findings:[...integerRanges.filter(range=>range.unsafe_rows!=='0').map(range=>({table:range.table,column:range.column,issue:'bigint_outside_javascript_safe_integer_range'})),...vectors.flatMap(vector=>vector.dimensions.filter(group=>group.dimensions!==null&&![768,1536].includes(group.dimensions)).map(group=>({table:vector.table,column:vector.column,issue:'vector_dimension_without_current_cloud_index',dimensions:group.dimensions})))],
   warm_round_trip_ms:{samples,p50:percentile(durations,.5),p95:percentile(durations,.95),p99:percentile(durations,.99)},
   collection_ms:milliseconds(performance.now()-collectionStart),
   limitations:['Only ordinary and partitioned tables are inventoried; views, functions, foreign tables, sequences and constraints need a separate migration manifest.','Physical size metrics are observational, not MVCC snapshots.','PostgreSQL storage bytes do not predict SQLite/D1 storage bytes.','Warm SELECT 1 timing excludes connection setup and is not API latency or a cold-start measurement.','Counts and bigint/vector aggregates scan data and can incur source database cost.','Cost estimates, API E2E latency, search recall and D1/Vectorize capacity gates require additional measurements.'],
  };
 }catch(error){await client.query('ROLLBACK');throw error;}
}
