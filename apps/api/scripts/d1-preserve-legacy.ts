import pg from 'pg';
import {open} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {buildPreservedTablePolicy,readPreservationEvidence} from './migrations/d1/preserved-tables';
import {readPrivateInput} from './migrations/d1/private-input';
export async function main(args=process.argv.slice(2)){
 const options=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){if(!['--backup-dir','--tables','--output'].includes(args[i])||options.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Invalid preservation policy arguments.');options.set(args[i],args[i+1]);}
 if(options.size!==3||!process.env.DATABASE_URL)throw new Error('Backup directory, explicit table list, output and restored database are required.');
 const url=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.search||url.hash)throw new Error('Use only the restored loopback database.');
 const evidence=await readPreservationEvidence(resolve(options.get('--backup-dir')!));
 const names:unknown=JSON.parse((await readPrivateInput(resolve(options.get('--tables')!),1024**2)).toString());
 if(!Array.isArray(names)||!names.every(name=>typeof name==='string'))throw new Error('Explicit table names are required.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1')));
 const client=new pg.Client({connectionString:url.toString(),application_name:'videoq-restored-legacy-policy',connectionTimeoutMillis:10000});
 try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='300s';SET LOCAL DateStyle='ISO, YMD';SET LOCAL TimeZone='UTC';SET LOCAL extra_float_digits=3");
  const policy=await buildPreservedTablePolicy(client,manifest,names,evidence);await client.query('COMMIT');
  const file=await open(resolve(options.get('--output')!),'wx',0o600);try{await file.writeFile(JSON.stringify(policy)+'\n');await file.sync();}finally{await file.close();}
  console.info(JSON.stringify({event:'preserved_legacy_policy_created',excluded_tables:policy.tables.length,execution_complete:false}));
 }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('Preserved legacy policy creation failed; no source rows, credentials or private policy are logged.');process.exitCode=1;}}
