const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {webcrypto}=require('node:crypto');
const core=import('../../infra/cloudflare-maintenance/coordinator.mjs');
const auth=import('../../infra/cloudflare-maintenance/auth.mjs');
function sqlite(db=new DatabaseSync(':memory:')){
 return {db,sql:{exec(sql,...args){return {toArray:()=>db.prepare(sql).all(...args)};}},transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
// Production sql.exec runs immediately, including DDL and writes.
function storage(db=new DatabaseSync(':memory:')){
 const s=sqlite(db);s.sql.exec=(sql,...args)=>{const statement=db.prepare(sql);const rows=statement.all(...args);return {toArray:()=>rows};};return s;
}
const identity=(runId='123',kind='migration',attempt=1)=>({runId,kind,attempt,source:'a'.repeat(40),workflow:kind==='smoke'?'operations.yml':'cd.yml'});
test('global ownership persists through restart/time and excludes another operation',async()=>{
 const {CoordinatorStore,runKey}=await core;const s=storage();const one=identity(),two=identity('124','smoke');const id=await runKey(one),other=await runKey(two);let store=new CoordinatorStore(s,()=>1);
 const first=await store.operate(id,one,{action:'acquire',writersStopped:true});assert.equal(first.state,'running');assert.deepEqual(await store.operate(id,one,{action:'acquire',writersStopped:true}),first);
 store=new CoordinatorStore(s,()=>Number.MAX_SAFE_INTEGER);await assert.rejects(store.operate(other,two,{action:'acquire',writersStopped:false}),/BUSY/);assert.equal((await store.operate(id,one,{action:'assert'})).state,'running');s.db.close();
});
test('failed jobs retain lock; only later same-run attempt resumes immutable records',async()=>{
 const {CoordinatorStore,runKey}=await core;const s=storage(),store=new CoordinatorStore(s);const one=identity(),id=await runKey(one);await store.operate(id,one,{action:'acquire',writersStopped:true});await store.operate(id,one,{action:'save',key:'background-queues',value:{originalPaused:false}});await store.operate(id,one,{action:'fail'});
 await assert.rejects(store.operate(id,one,{action:'release'}),/COMPLETION_PROOF/);await assert.rejects(store.operate(id,one,{action:'acquire',writersStopped:true}),/RECOVERY/);const retry={...one,attempt:2};await store.operate(id,retry,{action:'acquire',writersStopped:true});await assert.rejects(store.operate(id,one,{action:'assert'}),/OWNERSHIP/);
 assert.deepEqual(await store.operate(id,retry,{action:'load',key:'background-queues'}),{value:{originalPaused:false}});await assert.rejects(store.operate(id,retry,{action:'save',key:'background-queues',value:{originalPaused:true}}),/IMMUTABLE/);s.db.close();
});
test('success proof is required before release; release is idempotent after lost response',async()=>{
 const {CoordinatorStore,runKey}=await core;const s=storage(),store=new CoordinatorStore(s),one=identity('125','smoke'),id=await runKey(one);await store.operate(id,one,{action:'acquire',writersStopped:false});await assert.rejects(store.operate(id,one,{action:'complete'}),/COMPLETION_PROOF/);
 await store.operate(id,one,{action:'save',key:'operation-result',value:{version:1,kind:'smoke',run:id,source:one.source,syntheticCleanupComplete:true}});await store.operate(id,one,{action:'complete'});const result=await store.operate(id,one,{action:'release'});assert.equal(result.state,'released');assert.deepEqual(await store.operate(id,one,{action:'release'}),result);
 const two=identity('126','migration');await store.operate(await runKey(two),two,{action:'acquire',writersStopped:false});await assert.rejects(store.operate(id,one,{action:'save',key:'background-restore',value:{}}),/OWNERSHIP/);s.db.close();
});
test('migration cannot release without its read-only or restored-background completion proof',async()=>{
 const {CoordinatorStore,runKey}=await core;for(const writersStopped of [true,false]){const s=storage(),store=new CoordinatorStore(s),one=identity(),id=await runKey(one);await store.operate(id,one,{action:'acquire',writersStopped});await store.operate(id,one,{action:'save',key:'operation-result',value:{version:1,kind:'migration',run:id,source:one.source,...(writersStopped?{backgroundRestored:true}:{readOnly:true})}});await store.operate(id,one,{action:'complete'});assert.equal((await store.operate(id,one,{action:'release'})).state,'released');s.db.close();}
});
async function signer(){
 const pair=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);const jwk={...await webcrypto.subtle.exportKey('jwk',pair.publicKey),kid:'test-key',alg:'RS256',use:'sig'};const now=Math.floor(Date.now()/1000);
 const claims={iss:'https://token.actions.githubusercontent.com',aud:'videoq-maintenance-prod',sub:'repo:videoq-jp@349188820/videoq@1083911938:environment:production-db-smoke',repository:'videoq-jp/videoq',repository_id:'1083911938',repository_owner_id:'349188820',ref:'refs/heads/main',ref_type:'branch',environment:'production-db-smoke',runner_environment:'github-hosted',event_name:'workflow_dispatch',workflow_ref:'videoq-jp/videoq/.github/workflows/operations.yml@refs/heads/main',sha:'a'.repeat(40),workflow_sha:'a'.repeat(40),run_id:'123',run_attempt:'1',iat:now,nbf:now,exp:now+300};
 const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');return {claims,jwk,async token(changes={},header={}){const text=b64({alg:'RS256',typ:'JWT',kid:'test-key',...header})+'.'+b64({...claims,...changes});const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,Buffer.from(text));return text+'.'+Buffer.from(signature).toString('base64url');}};
}
test('real RSA JWT verification binds audience/repository/owner/main/environment/workflow/attempt',async()=>{
 const {verifyIdentity}=await auth;const signed=await signer(),fetcher=async()=>Response.json({keys:[signed.jwk]});const options={fetcher,cryptoProvider:webcrypto};const verified=await verifyIdentity(await signed.token(),'smoke',options);assert.equal(verified.runId,'123');assert.equal(verified.workflow,'operations.yml');
 for(const change of [{sub:'repo:videoq-jp/videoq:environment:production-db-smoke'},{sub:'repo:videoq-jp@999/videoq@1083911938:environment:production-db-smoke'},{sub:'repo:videoq-jp@349188820/videoq@999:environment:production-db-smoke'},{aud:'other'},{repository_id:'999'},{repository_owner_id:'999'},{ref:'refs/heads/dev'},{environment:'production-app'},{runner_environment:'self-hosted'},{event_name:'pull_request'},{workflow_ref:'videoq-jp/videoq/.github/workflows/evil.yml@refs/heads/main'},{workflow_sha:'b'.repeat(40)},{run_attempt:'0'},{exp:1}])await assert.rejects(verifyIdentity(await signed.token(change),'smoke',options),/OIDC_REQUIRED/);
 const token=await signed.token();const pieces=token.split('.');pieces[1]=Buffer.from(JSON.stringify({...signed.claims,run_id:'999'})).toString('base64url');await assert.rejects(verifyIdentity(pieces.join('.'),'smoke',options),/OIDC_REQUIRED/);await assert.rejects(verifyIdentity(await signed.token({}, {alg:'none'}),'smoke',options),/OIDC_REQUIRED/);
});
test('new admission checks canonical main, current GitHub attempt and successful push CI',async()=>{
 const {verifyStart}=await auth;const one=identity('123','smoke');const data={run:{id:123,run_attempt:1,head_sha:one.source,head_branch:'main',status:'in_progress',path:'.github/workflows/operations.yml',repository:{id:1083911938}},main:{object:{sha:one.source}},ci:{workflow_runs:[{id:900,head_repository:{id:1083911938},head_sha:one.source,head_branch:'main',event:'push',status:'completed',conclusion:'success',repository:{id:1083911938}}]}};
 const fetcher=async url=>Response.json(url.includes('/actions/runs/')?data.run:url.includes('/git/ref/')?data.main:data.ci);await verifyStart(one,'x'.repeat(30),{fetcher});data.main.object.sha='b'.repeat(40);await assert.rejects(verifyStart(one,'x'.repeat(30),{fetcher}),/CANONICAL_MAIN/);await verifyStart(one,'x'.repeat(30),{fetcher,recovery:true});data.run.run_attempt=2;await assert.rejects(verifyStart(one,'x'.repeat(30),{fetcher,recovery:true}),/GITHUB_RUN/);data.run.run_attempt=1;data.ci.workflow_runs[0].event='pull_request';await assert.rejects(verifyStart(one,'x'.repeat(30),{fetcher,recovery:true}),/MAIN_CI/);
});
test('maintenance admission refuses a newer failed or running CI rather than using an older success',async()=>{
 const {verifyStart}=await auth,one=identity('123','smoke');
 const run={id:123,run_attempt:1,head_sha:one.source,head_branch:'main',status:'in_progress',path:'.github/workflows/operations.yml',repository:{id:1083911938}};
 const success={id:900,head_repository:{id:1083911938},head_sha:one.source,head_branch:'main',event:'push',status:'completed',conclusion:'success',repository:{id:1083911938}};
 for(const newer of [{status:'in_progress',conclusion:null},{status:'completed',conclusion:'failure'}]){
  const fetcher=async url=>Response.json(url.includes('/actions/runs/')?run:url.includes('/git/ref/')?{object:{sha:one.source}}:{workflow_runs:[success,{...success,id:901,...newer}]});
  await assert.rejects(verifyStart(one,'x'.repeat(30),{fetcher}),/MAIN_CI_REQUIRED/);
 }
});
test('status workflow identity has read-only authority and cannot authenticate as an operation',async()=>{
 const {verifyIdentity}=await auth,signed=await signer(),fetcher=async()=>Response.json({keys:[signed.jwk]});
 const token=await signed.token({workflow_ref:'videoq-jp/videoq/.github/workflows/maintenance-status.yml@refs/heads/main'});
 assert.equal((await verifyIdentity(token,'smoke',{fetcher,cryptoProvider:webcrypto,statusOnly:true})).access,'status');
 await assert.rejects(verifyIdentity(token,'smoke',{fetcher,cryptoProvider:webcrypto}),/OIDC_REQUIRED/);
 await assert.rejects(verifyIdentity(await signed.token(),'smoke',{fetcher,cryptoProvider:webcrypto,statusOnly:true}),/OIDC_REQUIRED/);
});
test('global status reads the failed owner without taking, releasing or rewriting ownership',async()=>{
 const {CoordinatorStore,runKey}=await core,s=storage(),store=new CoordinatorStore(s),one=identity(),id=await runKey(one);
 assert.deepEqual(store.status(),{owner:null});await store.operate(id,one,{action:'acquire',writersStopped:true});await store.operate(id,one,{action:'fail'});
 const expected={owner:{run:id,kind:'migration',source:one.source,attempt:1,state:'failed',writersStopped:true,githubRun:'123'}};
 assert.deepEqual(store.status(),expected);assert.deepEqual(store.status(),expected);assert.equal(store.owner(),id);s.db.close();
});
test('global status refuses an orphaned owner rather than reporting an idle database',async()=>{
 const {CoordinatorStore}=await core,s=storage(),store=new CoordinatorStore(s);s.sql.exec('INSERT INTO maintenance_owner VALUES(1,?)','missing-run');assert.throws(()=>store.status(),/OWNERSHIP_REQUIRED/);s.db.close();
});
test('fixed ledger verification workflow authenticates only in the migration purpose environment',async()=>{
 const {verifyIdentity}=await auth,signed=await signer(),options={fetcher:async()=>Response.json({keys:[signed.jwk]}),cryptoProvider:webcrypto};
 const token=await signed.token({environment:'production-db-migration',sub:'repo:videoq-jp@349188820/videoq@1083911938:environment:production-db-migration',workflow_ref:'videoq-jp/videoq/.github/workflows/database-migrate.yml@refs/heads/main'});
 assert.equal((await verifyIdentity(token,'migration',options)).workflow,'database-migrate.yml');await assert.rejects(verifyIdentity(token,'smoke',options),/OIDC_REQUIRED/);
});

test('a queued aggregate run requires the exact current-attempt maintenance job to be running',async()=>{
 const {verifyStart}=await auth;
 for(const [workflow,kind,name] of [['cd.yml','migration','Drizzle DB Migrate'],['database-migrate.yml','migration','verify'],['operations.yml','smoke','production-smoke'],['maintenance-status.yml','migration','status (migration, production-db-migration)'],['maintenance-status.yml','smoke','status (smoke, production-db-smoke)']]){
  const one={...identity('123',kind),workflow};
  const run={id:123,run_attempt:1,head_sha:one.source,head_branch:'main',status:'queued',path:'.github/workflows/'+workflow,repository:{id:1083911938}};
  const job={name,status:'in_progress',conclusion:null,run_id:123,head_sha:one.source,completed_at:null};
  let jobs={total_count:1,jobs:[job]};let requestedAttempt=false;
  const fetcher=async url=>{
   if(url.endsWith('/attempts/1/jobs?per_page=100')){requestedAttempt=true;return Response.json(jobs);}
   if(url.includes('/actions/runs/'))return Response.json(run);
   if(url.includes('/git/ref/'))return Response.json({object:{sha:one.source}});
   return Response.json({workflow_runs:[{id:900,head_repository:{id:1083911938},head_sha:one.source,head_branch:'main',event:'push',status:'completed',conclusion:'success',repository:{id:1083911938}}]});
  };
  for(const status of ['queued','waiting','pending']){run.status=status;await verifyStart(one,'x'.repeat(30),{fetcher});assert.equal(requestedAttempt,true);}
  for(const change of [{status:'queued'},{status:'completed',conclusion:'success'},{name:'unrelated'},{run_id:124},{head_sha:'b'.repeat(40)},{completed_at:'2026-11-25T00:00:00Z'}]){
   jobs={total_count:1,jobs:[{...job,...change}]};await assert.rejects(verifyStart(one,'x'.repeat(30),{fetcher}),/GITHUB_RUN_REQUIRED/);
  }
  for(const invalid of [{total_count:0,jobs:[]},{total_count:101,jobs:[job]},{total_count:2,jobs:[job,job]}]){
   jobs=invalid;await assert.rejects(verifyStart(one,'x'.repeat(30),{fetcher}),/GITHUB_RUN_REQUIRED/);
  }
  jobs={total_count:1,jobs:[job]};run.status='completed';await assert.rejects(verifyStart(one,'x'.repeat(30),{fetcher}),/GITHUB_RUN_REQUIRED/);
 }
});

test('read-only failure recovery atomically records the handoff, preserves history and keeps one owner',async()=>{
 const {CoordinatorStore,runKey}=await core,s=storage(),store=new CoordinatorStore(s),old=identity(),oldId=await runKey(old);
 await store.operate(oldId,old,{action:'acquire',writersStopped:false});await store.operate(oldId,old,{action:'fail'});
 const next={...identity('456'),workflow:'schema-maintenance.yml',environment:'production-db-migration',source:'b'.repeat(40)},id=await runKey(next),previous={runId:old.runId,source:old.source,attempt:old.attempt};
 assert.equal((await store.recoverReadonly(next,previous)).writersStopped,true);assert.equal(store.owner(),id);assert.equal(store.row(oldId).state,'released');
 const receipt=s.db.prepare('SELECT value FROM maintenance_plans WHERE run=? AND name=?').get(oldId,'read-only-recovery');assert.equal(JSON.parse(receipt.value).run,id);
 assert.deepEqual(await store.recoverReadonly(next,previous),store.metadata(store.row(id)));
 await store.operate(id,next,{action:'fail'});await assert.rejects(store.recoverReadonly(next,previous),/RECOVERY_REQUIRED/);
 assert.equal((await store.recoverReadonly({...next,attempt:2},previous)).state,'running');assert.equal(store.owner(),id);
 await assert.rejects(store.recoverReadonly({...next,runId:'789'},previous),/RECOVERY_REQUIRED/);
 await assert.rejects(store.recoverReadonly({...next,attempt:2},{...previous,source:'c'.repeat(40)}),/RUN_CHANGED/);s.db.close();
});
test('recovery refuses running, writer-enabled, planned, mismatched and unauthorized owners',async()=>{
 const {CoordinatorStore,runKey}=await core;
 for(const change of ['running','writers','plan','source','attempt','workflow','environment']){
  const s=storage(),store=new CoordinatorStore(s),old=identity(),oldId=await runKey(old);
  await store.operate(oldId,old,{action:'acquire',writersStopped:change==='writers'});
  if(change==='plan')await store.operate(oldId,old,{action:'save',key:'background-queues',value:{synthetic:true}});
  if(change!=='running')await store.operate(oldId,old,{action:'fail'});
  const next={...identity('456'),workflow:change==='workflow'?'cd.yml':'schema-maintenance.yml',environment:change==='environment'?'production-app':'production-db-migration'},previous={runId:old.runId,source:change==='source'?'b'.repeat(40):old.source,attempt:change==='attempt'?2:1};
  await assert.rejects(store.recoverReadonly(next,previous));assert.equal(store.owner(),oldId);assert.equal(s.db.prepare('SELECT count(*) AS count FROM maintenance_runs').get().count,1);s.db.close();
 }
});
test('recovery requires the original terminal GitHub attempt, repository and canonical workflow',async()=>{
 const {verifyReadonlyFailure}=await auth,previous={runId:'123',source:'a'.repeat(40),attempt:1};
 const run={id:123,run_attempt:1,head_sha:previous.source,head_branch:'main',status:'completed',conclusion:'failure',repository:{id:1083911938},head_repository:{id:1083911938},path:'.github/workflows/cd.yml'};
 assert.deepEqual(await verifyReadonlyFailure(previous,'x'.repeat(30),{fetcher:async()=>Response.json(run)}),previous);
 for(const change of [{status:'in_progress'},{conclusion:'success'},{run_attempt:2},{head_sha:'b'.repeat(40)},{head_branch:'dev'},{repository:{id:999}},{head_repository:{id:999}},{path:'.github/workflows/evil.yml'}])await assert.rejects(verifyReadonlyFailure(previous,'x'.repeat(30),{fetcher:async()=>Response.json({...run,...change})}),/RECOVERY_REQUIRED/);
 for(const value of [{...previous,attempt:0},{...previous,runId:'../123'},{...previous,extra:true}])await assert.rejects(verifyReadonlyFailure(value,'x'.repeat(30)),/INVALID_MAINTENANCE_REQUEST/);
});
test('schema workflow identity is restricted to the two required protected environments',async()=>{
 const {verifyIdentity}=await auth,signed=await signer(),options={fetcher:async()=>Response.json({keys:[signed.jwk]}),cryptoProvider:webcrypto};
 for(const environment of ['production-db-migration','production-app']){
  const claims={environment,sub:'repo:videoq-jp@349188820/videoq@1083911938:environment:'+environment,workflow_ref:'videoq-jp/videoq/.github/workflows/schema-maintenance.yml@refs/heads/main'};
  assert.equal((await verifyIdentity(await signed.token(claims),'migration',options)).environment,environment);
  await assert.rejects(verifyIdentity(await signed.token({...claims,workflow_ref:'videoq-jp/videoq/.github/workflows/operations.yml@refs/heads/main'}),'migration',options),/OIDC_REQUIRED/);
  await assert.rejects(verifyIdentity(await signed.token(claims),'smoke',options),/OIDC_REQUIRED/);
 }
});
test('schema ownership cannot complete until both schema restoration and public readiness are recorded',async()=>{
 const {CoordinatorStore,runKey}=await core,s=storage(),store=new CoordinatorStore(s),one={...identity('555'),workflow:'schema-maintenance.yml',environment:'production-db-migration'},id=await runKey(one);
 await store.operate(id,one,{action:'acquire',writersStopped:true});
 await store.operate(id,one,{action:'save',key:'operation-result',value:{version:1,kind:'migration',run:id,source:one.source,backgroundRestored:true,apiTrafficRestored:true}});
 await assert.rejects(store.operate(id,one,{action:'complete'}),/COMPLETION_PROOF/);
 await store.operate(id,one,{action:'save',key:'schema-maintenance-result',value:{version:1,run:id,source:one.source,schemaCompleted:true,backgroundRestored:true}});
 await assert.rejects(store.operate(id,one,{action:'complete'}),/COMPLETION_PROOF/);
 await store.operate(id,one,{action:'save',key:'api-traffic-resumed',value:{version:1,run:id,source:one.source,applicationReadyVerified:true}});
 assert.equal((await store.operate(id,one,{action:'complete'})).state,'completed');s.db.close();
});
