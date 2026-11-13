import pg from 'pg';
import {open,mkdtemp,link,rm} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {collectSourceSchema} from './migrations/d1/source-schema';
import {loadMigrationSnapshot} from './d1-migration-manifest';
export async function main(args=process.argv.slice(2)){
 if(args.length!==2||args[0]!=='--output'||!args[1]||!process.env.DATABASE_URL)throw new Error('DATABASE_URL and --output <private report> are required.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1'))),output=resolve(args[1]);
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'videoq-d1-source-schema',connectionTimeoutMillis:10000});let stage:string|undefined;
 try{await client.connect();const result=await collectSourceSchema(client,manifest);stage=await mkdtemp(join(dirname(output),'.videoq-source-schema-'));const temporary=join(stage,'report'),file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(result,null,2)+'\n');await file.sync();}finally{await file.close();}await link(temporary,output);console.info(JSON.stringify({source_schema_report_written:true,metadata_only:true,tables:result.tables.length,expected_tables:result.expected_tables,unmapped_tables:result.unmapped_tables.length,missing_tables:result.missing_tables.length,column_drift:result.column_drift.length,mapping_ready:result.mapping_ready,execution_complete:false}));if(!result.mapping_ready)process.exitCode=2;}
 finally{try{await client.end();}finally{if(stage)await rm(stage,{recursive:true,force:true});}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('Source schema assessment failed; no credentials or source values are logged.');process.exitCode=1;}}
