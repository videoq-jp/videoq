// Fully synthetic dump/restore -> private handoff -> fake S3 protocol. No SSM,
// AWS network call, live DB credentials or canonical-main deployment is used.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {readFile,access} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {retainStagedBackup,ARCHIVE_BUCKET} from './backup-archive.mjs';
const require=createRequire(import.meta.url);
const {runBackup}=require('../../infra/db-maintenance/runtime/backup.cjs');
const env={...process.env,VIDEOQ_RETAIN_BACKUP:'true',MAINTENANCE_STAGE:'backup',MAINTENANCE_RUN_ID:randomBytes(16).toString('hex'),
 CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-backup-prod:00000000-0000-0000-0000-000000000000',
 CODEBUILD_SOURCE_VERSION:'synthetic-fixture-only'};
for(const key of Object.keys(env))if(key.startsWith('AWS_')||key.startsWith('ACTIONS_ID_TOKEN_')||key==='DATABASE_URL')delete env[key];
const objects=new Map();let handoff;
const fakeAWS=async(command,args)=>{
 assert.equal(command,'aws');
 const value=flag=>args[args.indexOf(flag)+1];
 assert.equal(value('--bucket'),ARCHIVE_BUCKET);
 assert.equal(value('--expected-bucket-owner'),'257240362763');
 const key=value('--key');
 if(args[1]==='put-object'){
  assert.equal(value('--if-none-match'),'*');assert.equal(value('--server-side-encryption'),'AES256');
  assert.equal(objects.has(key),false);
  const body=await readFile(value('--body')),digest=createHash('sha256').update(body).digest('base64');
  assert.equal(value('--checksum-sha256'),digest);
  if(key.endsWith('/database.dump'))assert.equal(body.subarray(0,5).toString(),'PGDMP');
  else{
   const manifest=JSON.parse(body.toString('utf8'));
   assert.equal(manifest.status,'restored-and-retained');assert.equal(manifest.schemas.length,4);assert.equal(Object.keys(manifest.inventory).length,9);
  }
  const object={VersionId:'synthetic-version-'+objects.size,ChecksumSHA256:digest,ContentLength:body.length,ServerSideEncryption:'AES256'};
  objects.set(key,object);return {stdout:JSON.stringify(object)};
 }
 assert.equal(args[1],'head-object');const object=objects.get(key);
 assert.equal(value('--version-id'),object.VersionId);assert.equal(value('--checksum-mode'),'ENABLED');
 return {stdout:JSON.stringify(object)};
};
await runBackup({env,execute:(command,args,settings)=>{
 assert.equal(command,'python3');assert.deepEqual(args,['.github/scripts/with-neon-credentials.py','backup','node','.github/scripts/backup-restore.mjs']);
 // Replace credential retrieval only in this synthetic fixture; the actual DB
 // child receives no AWS credentials and creates its own loopback-only source.
 const childEnv={...settings.env};
 for(const key of Object.keys(childEnv))if(key.startsWith('AWS_')||key.startsWith('ACTIONS_ID_TOKEN_'))delete childEnv[key];
 execFileSync(process.execPath,['.github/scripts/backup-restore-fixture.mjs'],{env:childEnv,stdio:['ignore','pipe','pipe'],timeout:300000,maxBuffer:4000000});
},retain:async(directory,context)=>{
 handoff=directory;assert.equal(JSON.parse(await readFile('operations-report.json','utf8')).backup_retention,'staged');
 return retainStagedBackup(directory,context,fakeAWS);
}});
const report=JSON.parse(await readFile('operations-report.json','utf8'));
assert.equal(report.status,'ok');assert.equal(report.backup_retention,'retained');assert.equal(objects.size,2);
await assert.rejects(access(handoff),{code:'ENOENT'});
console.log('Synthetic PostgreSQL restore, credential-free DB handoff, parent-only fake S3 retention and cleanup succeeded.');
