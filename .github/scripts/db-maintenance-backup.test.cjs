const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {runBackup} = require('../../infra/db-maintenance/runtime/backup.cjs');
const env={VIDEOQ_RETAIN_BACKUP:'true',MAINTENANCE_STAGE:'backup',MAINTENANCE_RUN_ID:'a'.repeat(32),
 CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-backup-prod:12345678-1234-1234-1234-123456789abc',
 CODEBUILD_SOURCE_VERSION:'immutable-source-version',AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:'/synthetic-parent-credentials'};
async function fixture(t){
 const cwd=process.cwd(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'videoq-parent-backup-test-'));
 process.chdir(directory);
 t.after(async()=>{process.chdir(cwd);await fs.rm(directory,{recursive:true,force:true});});
 return {directory};
}
const report=retention=>({status:'ok',backup_retention:retention,details:[]});
test('runs the credential-stripping DB wrapper before parent-only retention and cleans handoff files',async t=>{
 await fixture(t);let handoff,childReturned=false;
 await runBackup({env,execute:(command,args,settings)=>{
  assert.equal(command,'python3');assert.deepEqual(args,['.github/scripts/with-neon-credentials.py','backup','node','.github/scripts/backup-restore.mjs']);
  assert.equal(settings.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,'Only the wrapper receives parent credentials to read its purpose parameter.');
  handoff=settings.env.VIDEOQ_BACKUP_HANDOFF;
  assert.ok(handoff.includes('videoq-backup-handoff-'));
  require('node:fs').writeFileSync('operations-report.json',JSON.stringify(report('staged')));
  childReturned=true;
 },retain:async(directory,context)=>{
  assert.equal(childReturned,true);assert.equal(directory,handoff);assert.equal(context.runId,env.MAINTENANCE_RUN_ID);
  assert.equal((await fs.stat(directory)).mode&0o777,0o700);
  await fs.writeFile(path.join(directory,'synthetic-sensitive-temporary-file'),'synthetic');return true;
 }});
 const result=JSON.parse(await fs.readFile('operations-report.json','utf8'));
 assert.equal(result.backup_retention,'retained');assert.equal(result.status,'ok');
 await assert.rejects(fs.access(handoff),{code:'ENOENT'});
});
test('failed parent upload marks the operation failed and removes private handoff',async t=>{
 await fixture(t);let handoff;
 await assert.rejects(runBackup({env,execute:(_command,_args,settings)=>{
  handoff=settings.env.VIDEOQ_BACKUP_HANDOFF;require('node:fs').writeFileSync('operations-report.json',JSON.stringify(report('staged')));
 },retain:async()=>{throw new Error('synthetic upload failure');}}),/synthetic upload failure/);
 const result=JSON.parse(await fs.readFile('operations-report.json','utf8'));
 assert.equal(result.status,'error');assert.equal(result.backup_retention,'failed');
 await assert.rejects(fs.access(handoff),{code:'ENOENT'});
});
test('child failure or incomplete result never invokes retention',async t=>{
 await fixture(t);let handoff;
 const retain=()=>assert.fail('Retention must wait for a successful complete child result.');
 await assert.rejects(runBackup({env,execute:(_command,_args,settings)=>{handoff=settings.env.VIDEOQ_BACKUP_HANDOFF;throw new Error('child failure');},retain}),/child failure/);
 await assert.rejects(fs.access(handoff),{code:'ENOENT'});
 await assert.rejects(runBackup({env,execute:()=>require('node:fs').writeFileSync('operations-report.json',JSON.stringify(report('disabled'))),retain}),/PRODUCTION_VERIFICATION_FAILED/);
});
test('disabled preservation creates no handoff and does not use AWS storage',async t=>{
 await fixture(t);
 await runBackup({env:{...env,VIDEOQ_RETAIN_BACKUP:'false'},execute:(_command,_args,settings)=>{
  assert.equal(settings.env.VIDEOQ_BACKUP_HANDOFF,'');require('node:fs').writeFileSync('operations-report.json',JSON.stringify(report('disabled')));
 },retain:()=>assert.fail('Retention is disabled.')});
 assert.equal(JSON.parse(await fs.readFile('operations-report.json','utf8')).backup_retention,'disabled');
});
test('rejects invalid build context before reading any source credential',async()=>{
 await assert.rejects(runBackup({env:{...env,MAINTENANCE_RUN_ID:'invalid'},execute:()=>assert.fail('No credential read')}),/INVALID_BACKUP_ARCHIVE_CONTEXT/);
});

test('exposes only allowlisted failure stages and never source errors or details',async t=>{
 await fixture(t);
 for (const stage of ['database-connect','read-only-snapshot','logical-backup','isolated-restore','row-count-and-constraint-verification','verified-backup-handoff','secret-database-url']) {
  const failed={status:'error',details:['- 失敗した段階: `'+stage+'`。DB接続情報・レコード・バックアップは出力していません。']};
  await assert.rejects(runBackup({env,execute:()=>require('node:fs').writeFileSync('operations-report.json',JSON.stringify(failed)),retain:()=>assert.fail('No upload after failure')}),error=>{
   assert.equal(error.message,stage==='secret-database-url'?'PRODUCTION_VERIFICATION_FAILED':'BACKUP_VERIFICATION_FAILED_'+stage.replaceAll('-','_').toUpperCase());return true;
  });
  assert.ok(!JSON.stringify(JSON.parse(await fs.readFile('operations-report.json','utf8'))).includes(stage));
 }
 for (const details of [null,{},['postgresql://synthetic-secret'],['- 失敗した段階: `logical-backup`。DB接続情報・レコード・バックアップは出力していません。','synthetic-secret']]) {
  await assert.rejects(runBackup({env,execute:()=>require('node:fs').writeFileSync('operations-report.json',JSON.stringify({status:'error',details}))}),/PRODUCTION_VERIFICATION_FAILED/);
 }
});
