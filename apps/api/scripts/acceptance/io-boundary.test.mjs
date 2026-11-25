const {test}=await import(process.env.VITEST==='true'?'vitest':'node:test');
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,writeFileSync,readFileSync,symlinkSync,statSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {withPrivateWorkspace,cloudflareUrl,applicationUrl,databaseId,acceptanceAccount,acceptanceOrigin} from './io-boundary.mjs';
const mockModule=new URL('../../test/helpers/acceptance-fetch-mock.mjs',import.meta.url).pathname;
const fixture=()=>{const dir=mkdtempSync(tmpdir()+'/videoq-io-test-');chmodSync(dir,0o700);return dir;};
test('atomic replacement cannot follow a destination symlink and serialized writers cannot lose updates',async()=>{
 const dir=fixture(),outside=fixture();try{
  writeFileSync(outside+'/victim','unchanged');symlinkSync(outside+'/victim',dir+'/receipt.json');
  await withPrivateWorkspace(dir,async workspace=>{
   assert.throws(()=>workspace.read('receipt.json'));
   workspace.write('receipt.json','safe replacement');assert.equal(readFileSync(outside+'/victim','utf8'),'unchanged');assert.equal(statSync(dir+'/receipt.json').mode&0o777,0o600);
   await assert.rejects(withPrivateWorkspace(dir,()=>assert.fail('Concurrent writer must not execute')),/EEXIST/);
   assert.throws(()=>workspace.outputName(outside+'/receipt.json','receipt.json'));
   assert.throws(()=>workspace.read('../victim'));
   assert.throws(()=>workspace.reserve('receipt.json'),/EEXIST/);
   assert.equal(workspace.read('absent.json',{optional:true}),undefined);
  });
  assert.deepEqual(readdirSync(dir),['receipt.json']);
  chmodSync(dir,0o755);await assert.rejects(withPrivateWorkspace(dir,()=>assert.fail('Insecure workspace')),/owner-only/);
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('request guards reject foreign authority, account traversal and malformed resource IDs',()=>{
 assert.equal(new URL(cloudflareUrl('/accounts/'+acceptanceAccount+'/d1/database/id')).origin,'https://api.cloudflare.com');
 for(const path of ['//evil.invalid','/accounts/other/d1/database/x','/accounts/'+acceptanceAccount+'/../../other'])assert.throws(()=>cloudflareUrl(path));
 for(const path of ['//evil.invalid','https://evil.invalid','/\\evil.invalid'])assert.throws(()=>applicationUrl(path));
 assert.equal(applicationUrl('/api/auth/sign-in/email'),acceptanceOrigin+'/api/auth/sign-in/email');
 assert.throws(()=>databaseId('../production'));assert.throws(()=>databaseId('-'.repeat(36)));
});
test('actual driver records a mocked fixed-target status atomically without real network or credential output',()=>{
 const dir=fixture();try{
  const name='videoq-acceptance-20261125-c33d',id='11111111-2222-3333-4444-555555555555';
  const config={name,account_id:acceptanceAccount,main:new URL('./deployed.worker.ts',import.meta.url).pathname,d1_databases:[{database_name:name,database_id:id}],r2_buckets:[{bucket_name:name}],vectorize:[{index_name:name}],workflows:[{name}],vars:{BETTER_AUTH_URL:acceptanceOrigin,OPERATIONAL_POLICY_WEBHOOK_URL:'https://'+name+'-sink.yukiharada1228.workers.dev/'}};
  writeFileSync(dir+'/wrangler.json',JSON.stringify(config));writeFileSync(dir+'/private.json',JSON.stringify({cookie:'fixture-private-cookie'}));
  const stdout=execFileSync(process.execPath,['--import',mockModule,new URL('./cloud-control.mjs',import.meta.url).pathname,'status'],{encoding:'utf8',env:{...process.env,ACCEPTANCE_PRIVATE_DIR:dir,ACCEPTANCE_REPORT_PATH:dir+'/receipt.json',ACCEPTANCE_MOCK_MODE:'status',CLOUDFLARE_API_TOKEN:'fixture-private-token'}});
  const report=JSON.parse(readFileSync(dir+'/receipt.json','utf8'));assert.equal(report.operations.length,1);assert.equal(report.operations[0].result.status,'complete');assert.equal(statSync(dir+'/receipt.json').mode&0o777,0o600);
  assert(!stdout.includes('fixture-private'));assert(!readFileSync(dir+'/receipt.json','utf8').includes('fixture-private'));assert(JSON.parse(readFileSync(dir+'/requests.json')).every(row=>row.redirect==='error'));assert(!readdirSync(dir).some(name=>name.startsWith('.acceptance-')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual analytics collector whitelists bounded metrics and writes credentials/SQL only to private evidence',()=>{
 const dir=fixture();try{
  const database='ca70322e-c692-44b2-9052-de5d01a60e61';writeFileSync(dir+'/wrangler.json',JSON.stringify({name:'videoq-acceptance-20261125-c33d',account_id:acceptanceAccount,d1_databases:[{database_id:database}]}));
  const stdout=execFileSync(process.execPath,['--import',mockModule,new URL('./collect-d1-insights.mjs',import.meta.url).pathname],{encoding:'utf8',env:{...process.env,ACCEPTANCE_PRIVATE_DIR:dir,ACCEPTANCE_MOCK_MODE:'analytics',CLOUDFLARE_API_TOKEN:'fixture-private-token'}});
  const report=readFileSync(dir+'/d1-insights-exact.json','utf8');assert.equal(JSON.parse(report).coverage.providerReportedRowsReadInSelectedGroups,3);assert(!report.includes('fixture-private'));assert(!report.includes('private-not-public'));assert(!stdout.includes('private'));assert.equal(statSync(dir+'/d1-insights-exact-private.json').mode&0o777,0o600);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('actual cleanup verifier rejects a substituted resource before any request',()=>{
 const dir=fixture();try{
  writeFileSync(dir+'/read-replay-schema-failure.json',JSON.stringify({account:acceptanceAccount,name:'videoq-acceptance-20261125-c33d-reads',database:'11111111-2222-3333-4444-555555555555'}));
  assert.throws(()=>execFileSync(process.execPath,['--import',mockModule,new URL('./verify-read-replay-cleanup.mjs',import.meta.url).pathname],{stdio:'pipe',env:{...process.env,ACCEPTANCE_PRIVATE_DIR:dir,ACCEPTANCE_MOCK_MODE:'forbid',CLOUDFLARE_API_TOKEN:'fixture-token'}}));
  assert(!readdirSync(dir).includes('network-attempt'));assert(!readdirSync(dir).includes('read-replay-independent-cleanup.json'));assert(!readdirSync(dir).includes('.acceptance-io.lock'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
