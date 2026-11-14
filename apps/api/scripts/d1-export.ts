import pg from 'pg';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {exportPostgresArchive} from './migrations/d1/export';
import {loadPreservedTablePolicy} from './migrations/d1/preserved-tables';
export async function main(args=process.argv.slice(2)){
 const allowed=new Set(['--output','--schema','--fetch-rows','--preserved-policy','--backup-dir']),options=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--')||options.has(args[i]))throw new Error('Invalid export arguments.');options.set(args[i],args[i+1]);}
 if(!process.env.DATABASE_URL||!options.get('--output'))throw new Error('DATABASE_URL and --output are required.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1')));
 if(options.has('--preserved-policy')!==options.has('--backup-dir'))throw new Error('Preserved policy and backup directory must be supplied together.');
 const preservedTables=options.has('--preserved-policy')?await loadPreservedTablePolicy(resolve(options.get('--backup-dir')!),resolve(options.get('--preserved-policy')!),manifest):undefined;
 const client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'videoq-d1-export',connectionTimeoutMillis:10000});
 try{await client.connect();const result=await exportPostgresArchive(client,manifest,resolve(options.get('--output')!),{schema:options.get('--schema'),preservedTables,fetchRows:options.has('--fetch-rows')?Number(options.get('--fetch-rows')):undefined});console.info(JSON.stringify({event:'d1_archive_written',...result,execution_complete:false}));}finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('D1 export failed. No source row contents or credentials are logged; inspect the output path before retrying.');process.exitCode=1;}}
