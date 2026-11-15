import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {lstat,mkdtemp,open,readdir,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {getPlatformProxy} from 'wrangler';
import type {D1Database} from '@cloudflare/workers-types';
import {z} from 'zod';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {readPrivateInput} from './migrations/d1/private-input';
import {prepareD1WriteFence,inspectD1WriteFence,installD1WriteFence,releaseD1WriteFence} from './migrations/d1/write-fence';
const targetSchema=z.object({version:z.literal(1),accountId:z.literal('12daec56fdba43f677f2766ee26a5a39'),databaseId:z.uuid(),databaseName:z.string().regex(/^videoq-[a-z0-9-]{1,80}$/),purpose:z.enum(['isolated-rehearsal','production'])}).strict();
const stateSchema=z.object({target:targetSchema,manifestSha256:z.string(),plan:z.object({version:z.literal(1),databaseId:z.uuid(),operationId:z.string().regex(/^[a-f0-9]{32}$/),tables:z.array(z.string()).min(1).max(200),schemaSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict();
const fail=(message:string):never=>{throw new Error(message);};
export async function main(args=process.argv.slice(2)){
 const options=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){if(!['--mode','--state','--target','--confirm-database'].includes(args[i])||options.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))fail('Invalid write-fence arguments.');options.set(args[i],args[i+1]);}
 const mode=options.get('--mode'),prepare=mode==='prepare',mutate=mode==='install'||mode==='release';
 if(!['prepare','inspect','install','release'].includes(mode??'')||!options.has('--state')||options.size!==(prepare||mutate?3:2)||prepare&&!options.has('--target')||mutate&&!options.has('--confirm-database'))fail('Invalid write-fence operation options.');
 const statePath=resolve(options.get('--state')!),parent=await lstat(dirname(statePath));
 if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid?.())fail('Private operator-owned state directory required.');
 const previous=prepare?undefined:stateSchema.parse(JSON.parse((await readPrivateInput(statePath,1024**2)).toString()));
 const target=prepare?targetSchema.parse(JSON.parse((await readPrivateInput(resolve(options.get('--target')!),65536)).toString())):previous!.target;
 if(mutate&&(options.get('--confirm-database')!==target.databaseId||process.env.VIDEOQ_MIGRATION_UPSTREAM_STOPPED!=='1'))fail('Exact database confirmation and stopped upstream are required.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(join(root,'drizzle')),await loadMigrationSnapshot(join(root,'drizzle-d1')));
 if(!manifest.mapping_complete)fail('Complete migration contract required.');
 const manifestSha256=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 if(previous&&(previous.manifestSha256!==manifestSha256||previous.plan.databaseId!==target.databaseId))fail('Write-fence state differs from target or current migration contract.');
 // Reserve new state before connecting; install never depends on an unwritten plan.
 const output=prepare?await open(statePath,'wx',0o600):undefined;
 const directory=await mkdtemp(join(dirname(statePath),'.d1-write-fence-'));
 try{
  const configPath=join(directory,'wrangler.json');
  await writeFile(join(directory,'worker.js'),"export default {fetch(){return new Response(null,{status:404})}};",{mode:0o600});
  await writeFile(configPath,JSON.stringify({name:'videoq-db-write-fence-operator',account_id:target.accountId,main:join(directory,'worker.js'),compatibility_date:'2026-11-14',workers_dev:false,preview_urls:false,routes:[],d1_databases:[{binding:'DB',database_name:target.databaseName,database_id:target.databaseId,remote:true}]}),{mode:0o600});
  const require=createRequire(import.meta.url),bin=join(dirname(require.resolve('wrangler/package.json')),'bin/wrangler.js');
  const env={...process.env};for(const key of Object.keys(env))if(!['PATH','HOME','TMPDIR','LANG','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'].includes(key))delete env[key];
  env.CI='true';env.WRANGLER_SEND_METRICS='false';env.WRANGLER_LOG_PATH=join(directory,'wrangler.log');
  const info=z.object({uuid:z.uuid(),name:z.string()}).passthrough().parse(JSON.parse((await promisify(execFile)(process.execPath,[bin,'d1','info','DB','--json','--config',configPath],{env,timeout:60000,maxBuffer:1024**2})).stdout));
  if(info.uuid!==target.databaseId||info.name!==target.databaseName)fail('Cloudflare management identity differs from the write-fence target.');
  const proxy=await getPlatformProxy<{DB:D1Database}>({configPath,envFiles:[],persist:false,remoteBindings:true});
  try{
   const connection={database:proxy.env.DB,databaseId:target.databaseId};
   const expected=[...manifest.target_insert_order,'d1_migrations'].sort();
   const migrations=(await proxy.env.DB.prepare('SELECT name FROM d1_migrations ORDER BY name').all<{name:string}>()).results.map(r=>r.name);
   if(JSON.stringify(migrations)!==JSON.stringify((await readdir(join(root,'drizzle-d1'))).filter(n=>n.endsWith('.sql')).sort()))fail('Remote migration ledger differs from current migration chain.');
   if(prepare){
    const plan=await prepareD1WriteFence(connection,expected,randomUUID().replaceAll('-',''));
    await output!.writeFile(JSON.stringify({target,manifestSha256,plan})+'\n');await output!.sync();
    console.info(JSON.stringify({prepared:true,writeFenceInstalled:false,tables:plan.tables.length,purpose:target.purpose}));
   }else{
    if(JSON.stringify([...previous!.plan.tables].sort())!==JSON.stringify(expected))fail('Write-fence state has incomplete table coverage.');
    const result=mode==='install'?await installD1WriteFence(connection,previous!.plan):mode==='release'?await releaseD1WriteFence(connection,previous!.plan):await inspectD1WriteFence(connection,previous!.plan);
    console.info(JSON.stringify({state:result.state,installedTriggers:result.installedTriggers,expectedTriggers:result.expectedTriggers,purpose:target.purpose,externalWritersStoppedByThisCommand:false}));
   }
  }finally{await proxy.dispose();}
 }finally{await output?.close();await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('D1 write-fence operation failed. Keep upstream writers stopped; inspect the private state and target. No automatic release was attempted.');process.exitCode=1;}}
