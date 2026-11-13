import {mkdir,open,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ARCHIVE_BUCKET,BACKUP_SCHEMAS,inspectPrivateBackupFile} from './backup-archive.mjs';
const execute=promisify(execFile),maxArtifact=5*1024**3;
const sha=value=>typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value);
const version=value=>typeof value==='string'&&value!==''&&value!=='null'&&Buffer.byteLength(value,'utf8')<=1024&&!/[\x00-\x20\x7f]/.test(value);
const count=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value);
export class BackupDownloadError extends Error {name='BackupDownloadError';}
const fail=()=>{throw new BackupDownloadError('Private backup retrieval failed; inspect the explicit version, read permissions and private destination.');};
function objectRef(ref,key){
 if(!ref||ref.key!==key||!version(ref.version_id)||!Number.isSafeInteger(ref.bytes)||ref.bytes<=0||ref.bytes>maxArtifact||!sha(ref.sha256_base64))fail();
 return ref;
}
function validateManifest(manifest,runId,requireD1){
 const prefix='verified/'+runId+'/';
 if(!manifest||![1,2].includes(manifest.version)||manifest.status!=='restored-and-retained'||
   JSON.stringify(manifest.schemas)!==JSON.stringify(BACKUP_SCHEMAS)||
   !/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-backup-prod:[a-f0-9-]{36}$/.test(manifest.source?.build_arn)||
   typeof manifest.source?.operator_source_version!=='string'||!manifest.source.operator_source_version||manifest.source.operator_source_version.length>1024||
   manifest.source.snapshot!=='repeatable-read/read-only'||!/^pgvector\/pgvector:pg17@sha256:[a-f0-9]{64}$/.test(manifest.restore_image)||
   !manifest.inventory||typeof manifest.inventory!=='object'||Array.isArray(manifest.inventory)||!Object.keys(manifest.inventory).length||
   Object.values(manifest.inventory).some(value=>!count(value)))fail();
 objectRef(manifest.dump,prefix+'database.dump');
 if(manifest.version===1){if(requireD1||manifest.d1_export!==undefined)fail();}
 else{
  const d1=manifest.d1_export;
  if(manifest.execution_complete!==false||!d1||d1.format_version!==3||!/^[a-f0-9]{64}$/.test(d1.archive_sha256)||
    !Number.isSafeInteger(d1.tables)||d1.tables<1||!count(d1.rows)||d1.source!=='isolated restored database from this dump')fail();
  objectRef(d1.artifact,prefix+'d1-source.videoq-export.ndjson');
 }
 return manifest;
}

/** Transport integrity only; caller must also validate the archive against the
 * intended migration mapping and rehearse recovery before any cutover. This
 * function never lists buckets/versions, fetches credentials or selects latest. */
export async function downloadVerifiedBackup({runId,manifestVersion,outputDirectory,requireD1=false,env=process.env},run=execute){
 if(!/^[a-f0-9]{32}$/.test(runId)||!version(manifestVersion)||typeof outputDirectory!=='string'||!outputDirectory||typeof requireD1!=='boolean')fail();
 const directory=resolve(outputDirectory);let created=false;
 const childEnv=Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('AWS_')||['PATH','HOME','TMPDIR','LANG'].includes(key)));
 childEnv.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true';childEnv.AWS_PAGER='';
 const call=async(kind,key,id,file)=>{
  const args=['s3api',kind,'--bucket',ARCHIVE_BUCKET,'--key',key,'--version-id='+id,'--checksum-mode','ENABLED',
   '--expected-bucket-owner','257240362763','--region','ap-northeast-1','--output','json','--no-cli-pager',...(file?[file]:[])];
  const {stdout}=await run('aws',args,{env:childEnv,timeout:900000,maxBuffer:1000000});return JSON.parse(stdout);
 };
 const check=(result,id,limit,expected)=>{
  if(result.VersionId!==id||result.DeleteMarker||result.ServerSideEncryption!=='AES256'||!sha(result.ChecksumSHA256)||
    !Number.isSafeInteger(result.ContentLength)||result.ContentLength<=0||result.ContentLength>limit||
    expected&&(result.ContentLength!==expected.bytes||result.ChecksumSHA256!==expected.sha256_base64))fail();
 };
 const get=async(name,key,id,limit,expected)=>{
  const head=await call('head-object',key,id);check(head,id,limit,expected);
  const path=join(directory,name),file=await open(path,'wx',0o600);await file.close();
  const result=await call('get-object',key,id,path);check(result,id,limit,{bytes:head.ContentLength,sha256_base64:head.ChecksumSHA256});
  const local=await inspectPrivateBackupFile(path,limit,name==='verified-backup.json');
  if(local.bytes!==head.ContentLength||local.sha256_base64!==head.ChecksumSHA256)fail();
  return local;
 };
 try{
  // Exclusive mkdir preserves any existing directory; only our new private
  // directory is removed on failure. Files are precreated as 0600 before GET.
  await mkdir(directory,{mode:0o700});created=true;
  const manifestFile=await get('verified-backup.json','verified/'+runId+'/verified-backup.json',manifestVersion,4*1024*1024);
  const manifest=validateManifest(JSON.parse(manifestFile.text),runId,requireD1);
  await get('database.dump',manifest.dump.key,manifest.dump.version_id,maxArtifact,manifest.dump);
  if(manifest.d1_export){const artifact=manifest.d1_export.artifact;await get('d1-source.videoq-export.ndjson',artifact.key,artifact.version_id,maxArtifact,artifact);}
  const receipt={version:1,transport_integrity_verified:true,source_run_id:runId,manifest_version_id:manifestVersion,
   manifest_sha256_base64:manifestFile.sha256_base64,dump:manifest.dump,...(manifest.d1_export?{d1_export:manifest.d1_export}:{}),
   d1_archive_format_verified:false,execution_complete:false};
  const file=await open(join(directory,'download-verified.json'),'wx',0o600);
  try{await file.writeFile(JSON.stringify(receipt)+'\n');await file.sync();}finally{await file.close();}
  return {backup_download_verified:true,objects_downloaded:manifest.d1_export?3:2,d1_input_present:Boolean(manifest.d1_export),
   d1_archive_format_verified:false,execution_complete:false};
 }catch{
  if(created)await rm(directory,{recursive:true,force:true});fail();
 }
}

export function parseBackupDownloadArguments(args){
 const values=new Map();let requireD1=false;
 for(let i=0;i<args.length;i++){
  const key=args[i];if(key==='--require-d1'){if(requireD1)fail();requireD1=true;continue;}
  if(!['--run-id','--manifest-version','--output-dir'].includes(key)||values.has(key)||!args[i+1]||args[i+1].startsWith('--'))fail();values.set(key,args[++i]);
 }
 if(values.size!==3)fail();
 return {runId:values.get('--run-id'),manifestVersion:values.get('--manifest-version'),outputDirectory:values.get('--output-dir'),requireD1};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href){
 try{console.info(JSON.stringify(await downloadVerifiedBackup(parseBackupDownloadArguments(process.argv.slice(2)))));}
 catch{console.error('Private backup download failed. No records, credentials or private receipts are logged.');process.exitCode=1;}
}
