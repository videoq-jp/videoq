// Real PostgreSQL dump/restore plus the ACTUAL operator ZIP's isolated export.
// Synthetic rows only. No SSM, AWS network calls or live credentials are used.
import {createRequire} from 'node:module';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,mkdir,symlink,rm,access,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(new URL('../operations-tools/package.json',import.meta.url)),{Client}=require('pg');
const execute=promisify(execFile),root=resolve('.'),directory=await mkdtemp(join(tmpdir(),'videoq-ops-d1-export-'));
const key=randomBytes(8).toString('hex'),names=['source','restore'].map(part=>`videoq-ops-d1-${part}-${key}`);
const image=(await readFile(new URL('../operations-tools/Dockerfile',import.meta.url),'utf8')).trim().replace(/^FROM /,'');
const clients=[],started=[];
const docker=(args,options={})=>execute('docker',args,{timeout:300000,maxBuffer:4000000,...options});
const quote=name=>'"'+name.replaceAll('"','""')+'"';
async function start(name){
 const password=randomBytes(24).toString('hex');
 await docker(['run','--detach','--name',name,'-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432',image],{env:{...process.env,POSTGRES_PASSWORD:password}});started.push(name);
 for(let i=0;i<60;i++){try{await docker(['exec',name,'pg_isready','-U','postgres']);break;}catch{if(i===59)throw new Error('Synthetic fixture startup failed');await delay(500);}}
 const {stdout}=await docker(['port',name,'5432/tcp']),port=/^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];assert.ok(port);
 const url=new URL(`postgresql://postgres@127.0.0.1:${port}/postgres`);url.password=password;
 let client;
 for(let attempt=0;attempt<60;attempt++){
  client=new Client({connectionString:url.toString(),connectionTimeoutMillis:2000});client.on('error',()=>undefined);
  try{await client.connect();await client.query('SELECT 1');clients.push(client);return {client,url};}
  catch{await client.end().catch(()=>undefined);if(attempt===59)throw new Error('Synthetic TCP database startup failed');await delay(500);}
 }
}
async function snapshot(dialect){
 const meta=join(root,'apps/api',dialect,'meta'),journal=JSON.parse(await readFile(join(meta,'_journal.json'),'utf8'));
 return JSON.parse(await readFile(join(meta,String(journal.entries.at(-1).idx).padStart(4,'0')+'_snapshot.json'),'utf8'));
}
function value(column){
 const type=column.type;
 if(type==='boolean')return false;
 if(['integer','bigint','double precision'].includes(type))return 0;
 if(type==='jsonb'||type==='json')return '{}';
 if(type==='text[]')return [];
 if(type==='timestamp with time zone'||type==='date')return '2026-01-01';
 if(type==='uuid')return '00000000-0000-4000-8000-000000000001';
 if(type==='text'||type.startsWith('varchar'))return 'synthetic';
 throw new Error('Fixture needs an explicit value for the current schema type.');
}
try{
 const source=await start(names[0]),restored=await start(names[1]);
 const schema=await snapshot('drizzle');await source.client.query('CREATE EXTENSION vector');
 for(const table of Object.values(schema.tables)){
  const columns=Object.values(table.columns),parts=columns.map(column=>`${quote(column.name)} ${column.type}${column.notNull?' NOT NULL':''}${column.primaryKey?' PRIMARY KEY':''}`);
  for(const composite of Object.values(table.compositePrimaryKeys??{}))parts.push(`PRIMARY KEY (${composite.columns.map(quote).join(',')})`);
  for(const unique of Object.values(table.uniqueConstraints??{}))parts.push(`CONSTRAINT ${quote(unique.name)} UNIQUE (${unique.columns.map(quote).join(',')})`);
  await source.client.query(`CREATE TABLE public.${quote(table.name)} (${parts.join(',')})`);
 }
 const tables=Object.values(schema.tables);
 for(const table of tables)for(const index of Object.values(table.indexes??{}).filter(index=>index.isUnique)){
  await source.client.query(`CREATE UNIQUE INDEX ${quote(index.name)} ON public.${quote(table.name)} (${index.columns.map(column=>column.isExpression?column.expression:quote(column.expression)).join(',')})${index.where?' WHERE '+index.where:''}`);
 }
 async function insert(name,overrides){
  const table=tables.find(table=>table.name===name),columns=Object.values(table.columns);
  const values=columns.map(column=>Object.hasOwn(overrides,column.name)?overrides[column.name]:column.notNull?value(column):null);
  await source.client.query(`INSERT INTO public.${quote(name)} (${columns.map(column=>quote(column.name)).join(',')}) VALUES (${values.map((_,index)=>'$'+(index+1)).join(',')})`,values);
 }
 const owner='synthetic-backup-owner';
 await insert('users',{id:owner,username:owner,email:owner+'@example.invalid'});
 await insert('videos',{id:1,user_id:owner,title:'Synthetic backup video',file:'synthetic.mp4',status:'completed'});
 for(const dimensions of [768,1536])await insert(dimensions===768?'scene_embeddings_768':'scene_embeddings',{
  langchain_id:'00000000-0000-4000-8000-000000000001',content:'Synthetic restored backup evidence',
  embedding:JSON.stringify(Array.from({length:dimensions},(_,index)=>index===0?1:.01)),user_id:owner,video_id:1,
  langchain_metadata:JSON.stringify({start_time:'00:00:01,000',end_time:'00:00:02,000',video_id:1,user_id:owner}),
 });
 for(const table of tables)for(const foreign of Object.values(table.foreignKeys??{})){
  await source.client.query(`ALTER TABLE public.${quote(table.name)} ADD CONSTRAINT ${quote(foreign.name)} FOREIGN KEY (${foreign.columnsFrom.map(quote).join(',')}) REFERENCES public.${quote(foreign.tableTo)} (${foreign.columnsTo.map(quote).join(',')})`);
 }
 await docker(['exec',names[0],'pg_dump','-U','postgres','--format=custom','--schema=public','--no-owner','--no-acl','--file=/tmp/synthetic.dump']);
 const dump=join(directory,'synthetic.dump');await docker(['cp',names[0]+':/tmp/synthetic.dump',dump]);
 await docker(['cp',dump,names[1]+':/tmp/synthetic.dump']);await restored.client.query('CREATE EXTENSION vector');
 const {stdout:toc}=await docker(['exec',names[1],'pg_restore','--list','/tmp/synthetic.dump']);
 const filtered=toc.split('\n').filter(line=>!/^\d+;\s+\d+\s+\d+\s+SCHEMA - public\s/.test(line)).join('\n');
 const list=join(directory,'restore.list');await writeFile(list,filtered,{mode:0o600});await docker(['cp',list,names[1]+':/tmp/restore.list']);
 await docker(['exec',names[1],'pg_restore','--exit-on-error','--no-owner','--no-acl','--use-list=/tmp/restore.list','-U','postgres','--dbname=postgres','/tmp/synthetic.dump']);
 const bundle=join(directory,'bundle');await mkdir(bundle,{mode:0o700});
 await execute('python3',['-c',"import importlib.util,sys,zipfile; from pathlib import Path; spec=importlib.util.spec_from_file_location('bundle','infra/db-maintenance/build_bundle.py'); b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b); p=Path(sys.argv[1])/'operator.zip'; b.archive(p,b.operator_files()); zipfile.ZipFile(p).extractall(sys.argv[1])",bundle],{timeout:30000});
 const ops=join(root,'.github/operations-tools/node_modules');
 await symlink(ops,join(bundle,'.github/operations-tools/node_modules'),'dir');
 const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 env.VIDEOQ_BACKUP_ISOLATED_EXPORT='true';env.DATABASE_URL=restored.url.toString();
 const entry=join(bundle,'.github/scripts/backup-d1-export.mts'),loader=pathToFileURL(join(ops,'tsx/dist/loader.mjs')).href;
 async function run(output,overrides={}){return execute(process.execPath,['--import',loader,entry,'--output',output],{cwd:bundle,env:{...env,...overrides},timeout:120000,maxBuffer:1000000});}
 async function output(){const parent=await mkdtemp(join(directory,'output-'));return join(parent,'d1-source.videoq-export.ndjson');}
 const positive=await output(),result=await run(positive),report=JSON.parse(result.stdout.trim());
 assert.equal(report.event,'restored_backup_d1_archive_verified');assert.equal(report.tables,58);assert.equal(report.rows,'4');assert.equal(report.execution_complete,false);
 assert.equal((await stat(positive)).mode&0o777,0o600);
 const bytes=await readFile(positive,'utf8');assert.ok(bytes.includes('Synthetic restored backup evidence'));
 const rerun=await run(positive).then(()=>null,error=>error);assert.equal(rerun.code,1);
 assert.equal(await readFile(positive,'utf8'),bytes);
 // Exercise the real packaged backup child -> exporter -> handoff -> AWS parent
 // bridge. Only SSM retrieval and the S3 network transport are simulated.
 const {runBackup}=createRequire(join(bundle,'package.json'))('./infra/db-maintenance/runtime/backup.cjs');
 const {retainStagedBackup}=await import(pathToFileURL(join(bundle,'.github/scripts/backup-archive.mjs')).href);
 const parentEnv={...env,VIDEOQ_RETAIN_BACKUP:'true',VIDEOQ_EXPORT_D1_FROM_BACKUP:'true',MAINTENANCE_STAGE:'backup',
  MAINTENANCE_RUN_ID:randomBytes(16).toString('hex'),CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-backup-prod:00000000-0000-0000-0000-000000000000',CODEBUILD_SOURCE_VERSION:'synthetic-fixture-only'};
 delete parentEnv.DATABASE_URL;delete parentEnv.VIDEOQ_BACKUP_ISOLATED_EXPORT;
 const objects=new Map();let archiveHash,handoff;
 const fakeAWS=async(command,args)=>{
  assert.equal(command,'aws');const value=flag=>args[args.indexOf(flag)+1],key=value('--key');
  assert.equal(value('--bucket'),'videoq-db-archives-prod-257240362763');assert.equal(value('--expected-bucket-owner'),'257240362763');
  if(args[1]==='put-object'){
   assert.equal(value('--if-none-match'),'*');assert.equal(value('--server-side-encryption'),'AES256');assert.equal(objects.has(key),false);
   const body=await readFile(value('--body')),digest=createHash('sha256').update(body).digest('base64');assert.equal(value('--checksum-sha256'),digest);
   if(key.endsWith('/database.dump'))assert.equal(body.subarray(0,5).toString(),'PGDMP');
   else if(key.endsWith('/d1-source.videoq-export.ndjson'))archiveHash=JSON.parse(body.toString('utf8').trim().split('\n').at(-1)).sha256;
   else{const marker=JSON.parse(body.toString('utf8'));assert.equal(marker.version,2);assert.equal(marker.execution_complete,false);assert.equal(marker.d1_export.archive_sha256,archiveHash);assert.equal(marker.d1_export.rows,'4');}
   const object={VersionId:'synthetic-'+objects.size,ChecksumSHA256:digest,ContentLength:body.length,ServerSideEncryption:'AES256'};objects.set(key,object);return {stdout:JSON.stringify(object)};
  }
  assert.equal(args[1],'head-object');const object=objects.get(key);assert.equal(value('--version-id'),object.VersionId);return {stdout:JSON.stringify(object)};
 };
 const executeBackup=(_command,args,settings)=>{
  assert.deepEqual(args,['.github/scripts/with-neon-credentials.py','backup','node','.github/scripts/backup-restore.mjs']);handoff=settings.env.VIDEOQ_BACKUP_HANDOFF;
  execFileSync(process.execPath,[join(bundle,'.github/scripts/backup-restore.mjs')],{cwd:bundle,
   env:{...settings.env,DATABASE_URL:source.url.toString()},stdio:['ignore','pipe','pipe'],timeout:300000,maxBuffer:4000000});
 };
 const previous=process.cwd();
 try{
  process.chdir(bundle);
  await runBackup({env:parentEnv,execute:executeBackup,retain:(folder,context,options)=>retainStagedBackup(folder,context,fakeAWS,options)});
  const final=JSON.parse(await readFile(join(bundle,'operations-report.json'),'utf8'));assert.equal(final.backup_retention,'retained');assert.equal(final.d1_archive,'retained');assert.equal(objects.size,3);
 }finally{process.chdir(previous);}
 await assert.rejects(access(handoff),{code:'ENOENT'});
 const modules=join(bundle,'node_modules');await rm(modules);await mkdir(join(modules,'pg'),{recursive:true});
 const canary=join(directory,'untrusted-module-loaded');
 await writeFile(join(modules,'pg/package.json'),JSON.stringify({name:'pg',main:'index.cjs'}));
 await writeFile(join(modules,'pg/index.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(canary)},'unexpected');`);
 const refused=await output();assert.equal((await run(refused).then(()=>null,error=>error)).code,1);
 await assert.rejects(access(canary),{code:'ENOENT'});await assert.rejects(access(refused),{code:'ENOENT'});
 await rm(modules,{recursive:true,force:true});await symlink('.github/operations-tools/node_modules',modules,'dir');
 for(const invalid of [restored.url.toString()+'?host=database.invalid',restored.url.toString().replace('127.0.0.1','database.invalid')]){
  const target=await output();assert.equal((await run(target,{DATABASE_URL:invalid}).then(()=>null,error=>error)).code,1);await assert.rejects(access(target),{code:'ENOENT'});
 }
 await restored.client.query("CREATE TABLE retired_legacy_fixture(id integer PRIMARY KEY,secret text); INSERT INTO retired_legacy_fixture VALUES(1,'synthetic-private-canary')");
 const target=await output(),failure=await run(target).then(()=>null,error=>error);assert.equal(failure.code,1);
 assert.ok(!failure.stderr.includes('synthetic-private-canary'));await assert.rejects(access(target),{code:'ENOENT'});
 await source.client.query('CREATE TABLE unmapped_source_table(id integer PRIMARY KEY)');
 try{
  process.chdir(bundle);
  await assert.rejects(runBackup({env:{...parentEnv,MAINTENANCE_RUN_ID:randomBytes(16).toString('hex')},execute:executeBackup,retain:()=>assert.fail('No upload for a failed D1 export')}),/PRODUCTION_VERIFICATION_FAILED/);
  const failed=JSON.parse(await readFile(join(bundle,'operations-report.json'),'utf8'));assert.equal(failed.status,'error');assert.equal(failed.d1_archive,'failed');assert.equal(objects.size,3);
 }finally{process.chdir(previous);}
 await assert.rejects(access(handoff),{code:'ENOENT'});
 console.log(JSON.stringify({synthetic_restored_backup_export_verified:true,packaged_operator_used:true,tables:58,rows:4,
  no_application_dependencies_loaded:true,overwrite_refused:true,non_loopback_and_query_override_refused:true,unmapped_legacy_table_refused:true,
  full_backup_export_handoff_parent_retention_bridge_verified:true,failed_export_cannot_downgrade_to_dump_only:true,aws_network_call_made:false,production_modified:false}));
}finally{
 for(const client of clients)await client.end().catch(()=>undefined);
 for(const name of started.reverse())await docker(['rm','--force','--volumes',name]);
 await rm(directory,{recursive:true,force:true});
}
