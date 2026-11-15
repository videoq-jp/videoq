import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {exportRestoredBackup} from './backup-d1-run.mjs';
import {backupD1ExportRequested} from './backup-archive.mjs';
const env={VIDEOQ_EXPORT_D1_FROM_BACKUP:'true',VIDEOQ_RETAIN_BACKUP:'true',MAINTENANCE_STAGE:'backup',MAINTENANCE_RUN_ID:'a'.repeat(32),
 CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-backup-prod:00000000-0000-0000-0000-000000000000',CODEBUILD_SOURCE_VERSION:'synthetic'};
const proof={event:'restored_backup_d1_archive_verified',version:3,tables:58,rows:'4',archive_sha256:'a'.repeat(64),
 file_bytes:17,file_sha256_base64:createHash('sha256').update('synthetic archive').digest('base64'),execution_complete:false};
test('D1 export is opt-in and requires enabled retention in the exact backup context',()=>{
 assert.equal(backupD1ExportRequested({}),false);
 for(const mutation of [{VIDEOQ_RETAIN_BACKUP:'false'},{VIDEOQ_EXPORT_D1_FROM_BACKUP:'1'},{MAINTENANCE_STAGE:'smoke'}])assert.throws(()=>backupD1ExportRequested({...env,...mutation}));
 assert.equal(backupD1ExportRequested(env),true);
});
test('export subprocess receives only restored credential and a minimal non-secret environment',async()=>{
 const local='postgresql://postgres:synthetic@127.0.0.1:1/postgres';
 const result=await exportRestoredBackup({databaseUrl:local,directory:'/private/synthetic',env:{...env,PATH:'/bin',DATABASE_URL:'source-credential-canary',PGPASSWORD:'source-password-canary',AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:'/source-role',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'oidc-canary'}},async(command,args,settings)=>{
  assert.equal(command,process.execPath);assert.equal(settings.env.DATABASE_URL,local);
  assert.deepEqual(Object.keys(settings.env).sort(),['DATABASE_URL','PATH','VIDEOQ_BACKUP_ISOLATED_EXPORT']);
  assert.ok(args[1].includes('/.github/operations-tools/node_modules/tsx/'));
  assert.equal(args.at(-1),'/private/synthetic/d1-source.videoq-export.ndjson');
  return {stdout:JSON.stringify(proof)};
 });
 assert.equal(result.archive_sha256,proof.archive_sha256);assert.equal(result.file_sha256_base64,proof.file_sha256_base64);
});
test('disabled export launches nothing and partial/unverified exporter output is rejected',async()=>{
 assert.equal(await exportRestoredBackup({env:{},databaseUrl:'unused',directory:'unused'},()=>assert.fail('No subprocess')),undefined);
 for(const invalid of [{...proof,execution_complete:true},{...proof,file_bytes:0},{...proof,version:2},{...proof,file_sha256_base64:undefined}]){
  await assert.rejects(exportRestoredBackup({env,databaseUrl:'unused',directory:'/private/synthetic'},async()=>({stdout:JSON.stringify(invalid)})),/D1_BACKUP_EXPORT_NOT_VERIFIED/);
 }
});
