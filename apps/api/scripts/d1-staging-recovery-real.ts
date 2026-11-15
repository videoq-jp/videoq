import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod,lstat,mkdtemp,open,readFile,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from 'zod';
import {loadMigrationSnapshot} from './d1-migration-manifest';
import {buildMigrationManifest} from './migrations/d1/manifest';
import {verifyPostgresArchive} from './migrations/d1/verify-archive';
import {openPrivateInput,readPrivateInput} from './migrations/d1/private-input';
import {validateStagingTarget} from './migrations/d1/staging-target';
import {prepareRealRecovery,runRealRecoveryPhase,RealRecoveryError,type RealRecoveryProvider} from './migrations/d1/real-recovery';
const execute=promisify(execFile),hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function main(args=process.argv.slice(2)){
 const options=new Map<string,string>();for(let i=0;i<args.length;i+=2){if(!['--mode','--state','--archive'].includes(args[i])||options.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new RealRecoveryError('Use --mode prepare|mutate|restore|verify --state <private file> --archive <private corpus>.');options.set(args[i],args[i+1]);}
 const mode=options.get('--mode');if(options.size!==3||!['prepare','mutate','restore','verify'].includes(mode??'')||process.env.PERSISTENCE_RECOVERY_TARGET_OFFLINE!=='1')throw new RealRecoveryError('An explicit offline target assertion and complete recovery options are required.');
 const statePath=resolve(options.get('--state')!),parent=await lstat(dirname(statePath));if(!parent.isDirectory()||(parent.mode&0o077)||parent.uid!==process.getuid?.())throw new RealRecoveryError('Recovery state requires a private operator-owned directory.');
 if(mode==='prepare'){try{await lstat(statePath);throw new RealRecoveryError('Recovery state already exists.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 const state:unknown=mode==='prepare'?undefined:JSON.parse((await readPrivateInput(statePath,1024**2)).toString());
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),target=validateStagingTarget(await readFile(join(root,'wrangler.d1-staging.jsonc'),'utf8'));
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(join(root,'drizzle')),await loadMigrationSnapshot(join(root,'drizzle-d1'))),archive=await verifyPostgresArchive(resolve(options.get('--archive')!),manifest);
 const required=['common','scenes',...(archive.table_summaries.some(table=>table.schema==='chat_memory')?['checkpoints']:[]),...(archive.table_summaries.some(table=>table.table==='video_visual_runs'&&table.rows!=='0')?['visuals']:[])];
 const directory=await mkdtemp(join(dirname(statePath),'.videoq-real-recovery-'));let exports=0;
 try{
  const config=join(directory,'wrangler.json');await writeFile(config,JSON.stringify({...target,main:join(root,target.main)}),{mode:0o600});
  const require=createRequire(import.meta.url),bin=join(dirname(require.resolve('wrangler/package.json')),'bin/wrangler.js'),database=target.d1_databases[0].database_name;
  const env={...process.env};for(const key of Object.keys(env))if(!['PATH','HOME','TMPDIR','LANG','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'].includes(key))delete env[key];env.WRANGLER_SEND_METRICS='false';env.WRANGLER_LOG_PATH=join(directory,'wrangler.log');
  const call=async(args:string[])=>{try{return (await execute(process.execPath,[bin,...args,'--config',config],{env,timeout:900000,maxBuffer:4*1024**2})).stdout;}catch{throw new RealRecoveryError('Cloudflare staging recovery command failed; private working files are retained for inspection.');}};
  const query=async(sql:string)=>{const raw:unknown=JSON.parse(await call(['d1','execute',database,'--remote','--command',sql,'--json']));return z.array(z.object({success:z.literal(true),results:z.array(z.record(z.string(),z.unknown()))}).passthrough()).parse(raw).flatMap(result=>result.results);};
  const provider:RealRecoveryProvider={
   async assertQuiescent(){
    const states=z.array(z.object({id:z.string(),status:z.string(),archive_sha256:z.string()})).parse(await query("SELECT id,status,archive_sha256 FROM migration_imports"));
    if(states.length!==required.length||required.some(id=>!states.some(state=>state.id===id&&state.status===(id==='common'?'common_imported':id+'_imported')&&state.archive_sha256===archive.archive_sha256)))throw new RealRecoveryError('All import phases must be complete for this archive.');
    const [tasks]=await query('SELECT count(*) AS total,count(completed_at) AS completed,sum(CASE WHEN lease_token IS NOT NULL THEN 1 ELSE 0 END) AS leased FROM scene_index_tasks');
    if(!tasks||tasks.total!==tasks.completed||Number(tasks.leased)!==0)throw new RealRecoveryError('Vector delivery must be complete and all writers stopped before recovery.');
   },
   async snapshot(){
    const catalog=z.array(z.object({type:z.string(),name:z.string(),tbl_name:z.string(),sql:z.string().nullable()})).parse(await query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB '_cf_*' AND tbl_name NOT GLOB '_cf_*' ORDER BY type,name"));
    const tables=catalog.filter(row=>row.type==='table'&&!row.name.startsWith('sqlite_')&&row.name!=='mutation_receipts').map(row=>row.name).sort();
    if(tables.some(name=>!manifest.target_insert_order.includes(name)&&name!=='d1_migrations')||manifest.target_insert_order.some(name=>name!=='mutation_receipts'&&!tables.includes(name)))throw new RealRecoveryError('Recovery target table inventory differs from the migration schema.');
    if(!tables.length||!catalog.some(row=>row.type==='table'&&row.name==='mutation_receipts'))throw new RealRecoveryError('Recovery target schema is incomplete.');
    const sequences=await query('SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name');
    const probe=z.array(z.object({token:z.string(),kind:z.string(),resource_id:z.number(),effect_applied:z.number()})).max(2).parse(await query('SELECT token,kind,resource_id,effect_applied FROM mutation_receipts LIMIT 2'));
    const output=join(directory,'snapshot-'+(exports++)+'.sql'),file=await open(output,'wx',0o600);await file.close();
    await call(['d1','export',database,'--remote','--skip-confirmation','--output',output,'--table',...tables]);await chmod(output,0o600);
    const input=await openPrivateInput(output),digest=createHash('sha256');let bytes=0;
    try{const buffer=Buffer.alloc(64*1024);for(;;){const {bytesRead}=await input.file.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;digest.update(buffer.subarray(0,bytesRead));}if(bytes!==input.info.size)throw new RealRecoveryError('Recovery export changed while hashing.');}finally{await input.file.close();}
    const snapshot={tables,data_sha256:digest.digest('hex'),data_bytes:bytes,schema_sha256:hash(catalog),sequences_sha256:hash(sequences),probe};await rm(output);return snapshot;
   },
   async bookmark(){return z.object({bookmark:z.string()}).passthrough().parse(JSON.parse(await call(['d1','time-travel','info',database,'--json'])) as unknown).bookmark;},
   async insertProbe(nonce){await query(`INSERT INTO mutation_receipts(token,kind,resource_id,effect_applied) VALUES('${z.uuid().parse(nonce)}','migration_recovery_probe',0,0)`);},
   async restore(bookmark){await call(['d1','time-travel','restore',database,'--bookmark='+bookmark,'--json']);},
  };
  if(mode==='prepare'){
   const result=await prepareRealRecovery(provider,archive.archive_sha256),file=await open(statePath,'wx',0o600);try{await file.writeFile(JSON.stringify(result)+'\n');await file.sync();}finally{await file.close();}
   console.info(JSON.stringify({real_data_recovery_state_prepared:true,tables:result.snapshot.tables.length+1,production_modified:false,execution_complete:false}));
  }else console.info(JSON.stringify(await runRealRecoveryPhase(provider,state,archive.archive_sha256,mode as 'mutate'|'restore'|'verify')));
  await rm(directory,{recursive:true,force:true});
 }catch(error){if(error instanceof RealRecoveryError)throw error;throw new RealRecoveryError('Real-data recovery phase failed. Keep the dedicated target offline and inspect the private state and working directory.');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch(error){console.error(error instanceof RealRecoveryError?error.message:'Real-data staging recovery failed; no records, credentials or private state are logged.');process.exitCode=1;}}
