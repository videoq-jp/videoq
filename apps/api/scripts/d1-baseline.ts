/** Read-only source inventory. DATABASE_URL is consumed but never printed. */
import {open,mkdtemp,link,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {collectPostgresBaseline} from './migrations/d1/baseline';
export async function main(args=process.argv.slice(2)){
 const allowed=new Set(['--output','--schema','--samples','--statement-timeout-ms']),options=new Map<string,string>();
 for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];if(!allowed.has(key)||!value||value.startsWith('--')||options.has(key))throw new Error('Invalid arguments.');options.set(key,value);}
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required.');
 if(!options.get('--output'))throw new Error('--output is required.');
 const output=resolve(options.get('--output')!);let stage:string|undefined;
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'videoq-d1-baseline',connectionTimeoutMillis:10000});
 try{
  await client.connect();
  const result=await collectPostgresBaseline(client,{schema:options.get('--schema'),samples:options.has('--samples')?Number(options.get('--samples')):undefined,statementTimeoutMs:options.has('--statement-timeout-ms')?Number(options.get('--statement-timeout-ms')):undefined});
  stage=await mkdtemp(join(dirname(output),'.videoq-d1-baseline-'));
  const temporary=join(stage,'report.json'),file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(result,null,2)+'\n');await file.sync();}finally{await file.close();}
  // Atomic publication without overwriting an earlier measurement.
  await link(temporary,output);
  console.info(JSON.stringify({event:'d1_baseline_written',tables:result.tables.length,vector_columns:result.vectors.length}));
 }finally{try{await client.end();}finally{if(stage)await rm(stage,{recursive:true,force:true});}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await main();}catch{console.error('D1 baseline failed. Inspect database access, arguments and timeouts; no source row data is logged.');process.exitCode=1;}
}
