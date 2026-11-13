import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,stat,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadVerifiedBackup,parseBackupDownloadArguments} from './backup-download.mjs';
import {ARCHIVE_BUCKET,BACKUP_SCHEMAS} from './backup-archive.mjs';
const runId='a'.repeat(32),prefix='verified/'+runId+'/',sha=body=>createHash('sha256').update(body).digest('base64');
async function fixture(t,{d1=true}={}){
 const directory=await mkdtemp(join(tmpdir(),'videoq-download-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const dump=Buffer.from('PGDMP synthetic'),archive=Buffer.from('synthetic archive');
 const ref=(name,body,id)=>({key:prefix+name,version_id:id,bytes:body.length,sha256_base64:sha(body)});
 const manifest={version:d1?2:1,status:'restored-and-retained',schemas:BACKUP_SCHEMAS,inventory:{'"public"."synthetic"':'1'},
  source:{build_arn:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-backup-prod:00000000-0000-0000-0000-000000000000',operator_source_version:'immutable-operator',snapshot:'repeatable-read/read-only'},
  restore_image:(await readFile(new URL('../operations-tools/Dockerfile',import.meta.url),'utf8')).trim().replace(/^FROM /,''),dump:ref('database.dump',dump,'dump-version'),
  ...(d1?{d1_export:{format_version:3,archive_sha256:'a'.repeat(64),tables:58,rows:'4',source:'isolated restored database from this dump',artifact:ref('d1-source.videoq-export.ndjson',archive,'archive-version')},execution_complete:false}:{})};
 const blobs=new Map(),calls=[];
 const reset=()=>{
  blobs.set(prefix+'verified-backup.json',{body:Buffer.from(JSON.stringify(manifest)),id:'manifest-version'});
  blobs.set(prefix+'database.dump',{body:dump,id:'dump-version'});blobs.set(prefix+'d1-source.videoq-export.ndjson',{body:archive,id:'archive-version'});
 };
 reset();
 const options={runId,manifestVersion:'manifest-version',outputDirectory:join(directory,'new-private'),requireD1:d1,
  env:{PATH:'/bin',AWS_PROFILE:'synthetic-reader',DATABASE_URL:'source-private-canary',PGPASSWORD:'private-password',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'oidc-canary'}};
 const run=async(command,args,settings)=>{
  calls.push(args);assert.equal(command,'aws');assert.ok(['head-object','get-object'].includes(args[1]));
  const value=flag=>args[args.indexOf(flag)+1];assert.equal(value('--bucket'),ARCHIVE_BUCKET);assert.equal(value('--expected-bucket-owner'),'257240362763');
  assert.equal(value('--checksum-mode'),'ENABLED');assert.equal(value('--region'),'ap-northeast-1');
  assert.equal(settings.env.DATABASE_URL,undefined);assert.equal(settings.env.PGPASSWORD,undefined);assert.equal(settings.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,undefined);
  assert.equal(settings.env.AWS_PROFILE,'synthetic-reader');assert.equal(settings.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS,'true');
  const blob=blobs.get(value('--key'));assert.ok(blob);assert.equal(args.find(arg=>arg.startsWith('--version-id=')),'--version-id='+blob.id);
  if(args[1]==='get-object')await writeFile(args.at(-1),blob.body);
  return {stdout:JSON.stringify({VersionId:blob.id,ContentLength:blob.body.length,ChecksumSHA256:sha(blob.body),ServerSideEncryption:'AES256'})};
 };
 return {options,run,manifest,blobs,calls,reset};
}
test('downloads explicit versions and verifies the complete private D1 artifact set',async t=>{
 const {options,run,calls}=await fixture(t),result=await downloadVerifiedBackup(options,run);
 assert.deepEqual(result,{backup_download_verified:true,objects_downloaded:3,d1_input_present:true,d1_archive_format_verified:false,execution_complete:false});
 assert.equal(calls.length,6);assert.equal((await stat(options.outputDirectory)).mode&0o777,0o700);
 for(const name of ['verified-backup.json','database.dump','d1-source.videoq-export.ndjson','download-verified.json'])assert.equal((await stat(join(options.outputDirectory,name))).mode&0o777,0o600);
 const receipt=JSON.parse(await readFile(join(options.outputDirectory,'download-verified.json'),'utf8'));
 assert.equal(receipt.manifest_version_id,'manifest-version');assert.equal(receipt.transport_integrity_verified,true);assert.equal(receipt.execution_complete,false);
 assert.ok(!JSON.stringify(result).includes(runId));assert.ok(!JSON.stringify(result).includes('version-id'));
});
test('preserves existing output directories and rejects latest or arbitrary target arguments',async t=>{
 const {options}=await fixture(t);await mkdir(options.outputDirectory);await writeFile(join(options.outputDirectory,'sentinel'),'keep');
 await assert.rejects(downloadVerifiedBackup(options,()=>assert.fail('No AWS request')));
 assert.equal(await readFile(join(options.outputDirectory,'sentinel'),'utf8'),'keep');
 for(const args of [[],['--bucket','other'],['--run-id','../other','--manifest-version','null','--output-dir','/tmp/synthetic']]){
  if(args.includes('--run-id'))await assert.rejects(downloadVerifiedBackup(parseBackupDownloadArguments(args),()=>assert.fail('No AWS')));
  else assert.throws(()=>parseBackupDownloadArguments(args));
 }
});
test('supports dump-only manifests but refuses them when D1 was explicitly required',async t=>{
 const f=await fixture(t,{d1:false});assert.equal((await downloadVerifiedBackup(f.options,f.run)).d1_input_present,false);
 const denied={...f.options,outputDirectory:f.options.outputDirectory+'-required',requireD1:true};
 await assert.rejects(downloadVerifiedBackup(denied,f.run));await assert.rejects(access(denied.outputDirectory),{code:'ENOENT'});
});
test('rejects cross-run object references before downloading unrelated objects',async t=>{
 const f=await fixture(t);f.manifest.dump.key='verified/'+'b'.repeat(32)+'/database.dump';f.reset();
 await assert.rejects(downloadVerifiedBackup(f.options,f.run));assert.equal(f.calls.length,2);
 await assert.rejects(access(f.options.outputDirectory),{code:'ENOENT'});
});
test('wrong version, checksum, encryption or size cannot publish a local completion receipt',async t=>{
 for(const mutation of [{VersionId:'other'},{ChecksumSHA256:'invalid'},{ServerSideEncryption:'none'},{ContentLength:0},{ContentLength:6*1024**3}]){
  const f=await fixture(t);
  await assert.rejects(downloadVerifiedBackup(f.options,async(...args)=>{
   const result=await f.run(...args);return {stdout:JSON.stringify({...JSON.parse(result.stdout),...mutation})};
  }));
  await assert.rejects(access(f.options.outputDirectory),{code:'ENOENT'});
 }
});
test('locally corrupted data, incomplete downloads or malformed manifests are removed',async t=>{
 for(const mode of ['corrupt','transport','manifest']){
  const f=await fixture(t);if(mode==='manifest'){f.manifest.execution_complete=true;f.reset();}
  await assert.rejects(downloadVerifiedBackup(f.options,async(command,args,settings)=>{
   if(mode==='transport'&&args[1]==='get-object')throw new Error('synthetic unavailable');
   const result=await f.run(command,args,settings);
   if(mode==='corrupt'&&args[1]==='get-object')await writeFile(args.at(-1),'corrupt');
   return result;
  }));
  await assert.rejects(access(f.options.outputDirectory),{code:'ENOENT'});
 }
});

test('artifact metadata must match the manifest before any data GET, and late corruption removes the whole set',async t=>{
 const stale=await fixture(t);stale.manifest.dump.bytes++;stale.reset();
 await assert.rejects(downloadVerifiedBackup(stale.options,stale.run));assert.equal(stale.calls.length,3);
 assert.ok(!stale.calls.some(args=>args[1]==='get-object'&&args[args.indexOf('--key')+1].endsWith('/database.dump')));
 await assert.rejects(access(stale.options.outputDirectory),{code:'ENOENT'});
 const late=await fixture(t);
 await assert.rejects(downloadVerifiedBackup(late.options,async(command,args,settings)=>{
  const result=await late.run(command,args,settings);
  if(args[1]==='get-object'&&args[args.indexOf('--key')+1].endsWith('/d1-source.videoq-export.ndjson'))await writeFile(args.at(-1),'late corruption');
  return result;
 }));
 assert.equal(late.calls.length,6);await assert.rejects(access(late.options.outputDirectory),{code:'ENOENT'});
});
test('raw transport errors and source credentials never reach the retrieval error',async t=>{
 const f=await fixture(t);let failure;
 try{await downloadVerifiedBackup(f.options,async()=>{throw new Error('private-url-password-canary');});}catch(error){failure=error;}
 assert.equal(failure.name,'BackupDownloadError');assert.ok(!String(failure).includes('private-url-password-canary'));
 await assert.rejects(access(f.options.outputDirectory),{code:'ENOENT'});
});

test('CLI invoked through a symlink still rejects invalid arguments without logging private inputs',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{symlink}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'videoq-download-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const alias=join(directory,'download.mjs');await symlink(new URL('./backup-download.mjs',import.meta.url),alias);
 let failure;try{await promisify(execFile)(process.execPath,[alias,'--manifest-version','private-version-canary']);}catch(error){failure=error;}
 assert.equal(failure.code,1);assert.equal(failure.stdout,'');assert.ok(!failure.stderr.includes('private-version-canary'));
});
