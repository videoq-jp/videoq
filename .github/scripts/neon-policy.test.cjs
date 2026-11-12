const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {runInNewContext}=require('node:vm');
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const {OWNER,PROFILES,loginName,connectionUrl,encodeJournal,decodeJournal,retirementRole}=require('./neon-policy.cjs');
const {denied,retire,rollback,finishRollback,completeRollback}=require('./neon-admin.cjs');

test('fresh credential checks do not install packages; due and forced rotations install before mutations',async()=>{
 const load=(createdAt)=>{
  const calls=[];
  const filename=resolve('.github/scripts/neon-admin.cjs'), nativeRequire=createRequire(filename);
  const fakeRequire=name=>name==='node:child_process'?{execFileSync:(command,args)=>{
   const request=JSON.parse(readFileSync(args.at(-1).slice('file://'.length),'utf8'));
   calls.push([args[1],request.Name]);
   if(args[1]==='describe-parameters')return '{"Parameters":[]}';
   if(request.Name===nativeRequire('./neon-policy.cjs').JOURNAL)throw new Error('absent');
   return JSON.stringify({Parameter:{Type:'SecureString',Value:JSON.stringify({created_at:createdAt}),Version:1}});
  }}:nativeRequire(name);
  const module={exports:{}};
  runInNewContext(readFileSync(filename,'utf8'),{require:fakeRequire,module,__dirname:resolve('.github/scripts'),
   process:{env:{}},console:{log(){}},URL,Buffer,Date});
  return {prepare:module.exports.prepare,calls};
 };
 const fresh=load(new Date().toISOString());
 assert.equal(await fresh.prepare(false,()=>assert.fail('unnecessary install')),null);
 for(const [createdAt,force] of [[new Date(0).toISOString(),false],[new Date().toISOString(),true]]){
  const fixture=load(createdAt);
  await assert.rejects(fixture.prepare(force,()=>{throw new Error('TOOLS_REQUIRED');}),/TOOLS_REQUIRED/);
  assert.ok(!fixture.calls.some(([command,name])=>command==='put-parameter'||name?.endsWith('/db-admin')));
 }
});

test('each consumer uses its own parameter and access role',()=>{
 assert.equal(new Set(Object.values(PROFILES).map(p=>p.parameter)).size,7);
 assert.equal(new Set(Object.values(PROFILES).map(p=>p.access)).size,7);
 for(const purpose of ['migration','backup','audit','smoke','demo']) {
  assert.match(PROFILES[purpose].parameter,/^\/videoq\/security\/prod\/db-/);
 }
});
test('rotating migration logins preserve the schema owner and enforce TLS verification',()=>{
 const generation='20261101010101_aabbccdd';
 const template='postgresql://admin:old@ep-old-truth-a1co51ud-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
 const u=new URL(connectionUrl(template,'migration',loginName('migration',generation),'new-password'));
 assert.equal(u.hostname,'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech');
 assert.equal(u.searchParams.get('options'),'-c role='+OWNER);
 assert.equal(u.searchParams.get('sslmode'),'verify-full');
 for(const purpose of ['api','worker']) assert.match(new URL(connectionUrl(template,purpose,'user','secret')).hostname,/-pooler\./);
 assert.throws(()=>loginName('unknown',generation));
 assert.throws(()=>loginName('api','arbitrary-sql'));
 assert.throws(()=>connectionUrl('postgres://u:p@attacker.invalid/db','api','u','p'));
});
test('permission checks fail closed when an operation succeeds or fails for another reason',async()=>{
 for(const code of [undefined,'42P01','08006']) {
  const calls=[];const client={query:async sql=>{calls.push(sql);if(sql==='WRITE'&&code)throw Object.assign(new Error(),{code});}};
  await assert.rejects(denied(client,'WRITE'),/PRIVILEGE_DENIAL_NOT_PROVEN/);
  assert.deepEqual(calls,['BEGIN','WRITE','ROLLBACK']);
 }
 await denied({query:async sql=>{if(sql==='WRITE')throw Object.assign(new Error(),{code:'42501'});}},'WRITE');
});
test('smoke and demo operators have no direct writes and use purpose-scoped environments',()=>{
 for(const file of ['production-smoke.mjs','provision-public-demo.mjs']) {
  const source=readFileSync('.github/scripts/'+file,'utf8');
  assert.doesNotMatch(source,/(?:UPDATE|INSERT INTO|DELETE FROM) (?:public\.)?(?:users|account|session)\b/);
 }
 const sql=readFileSync('infra/sql/neon-security.sql','utf8');
 assert.match(sql,/REVOKE ALL ON ALL FUNCTIONS IN SCHEMA videoq_security FROM PUBLIC/);
 assert.match(sql,/SECURITY DEFINER SET search_path=pg_catalog,public/);
 assert.match(sql,/username='ops_smoke_' \|\| id/);
 assert.match(sql,/existing\.username IS DISTINCT FROM 'videoq_public_demo'/);
 assert.doesNotMatch(sql,/GRANT (?:ALL|UPDATE|INSERT|DELETE).*TO videoq_(?:smoke|audit|demo)_access/);
});
test('rotation never revokes a credential before the Lambda grace period and verified jobs',()=>{
 const {definition}=require('../../infra/db-maintenance/state-machine.cjs');
 const {States:states}=definition({table:'metadata',projects:{rotation:'admin',migration:'migrate',backup:'backup',smoke:'smoke',audit:'audit'}});
 assert.equal(states.SmokeBeforeRetirement.Next,'BackupBeforeRetirement');
 assert.equal(states.AuditBeforeRetirement.Next,'WaitForInvocations');
 assert.equal(states.WaitForInvocations.TimestampPath,'$.decision.payload.retire_after');
 assert.equal(states.WaitForInvocations.Next,'Retire');
 assert.equal(states.Retire.Next,'SmokeAfterRetirement');
 const workflow=readFileSync('.github/workflows/neon-credentials.yml','utf8');
 assert.match(workflow,/group: production-db-maintenance/);
 assert.match(workflow,/cancel-in-progress: false/);
 assert.match(workflow,/environment: production-db-maintenance/);
 assert.match(workflow,/AWS_GITHUB_ACTIONS_DB_REQUEST_ROLE_ARN/);
 assert.doesNotMatch(workflow,/neon-admin\.cjs|neon-rotate\.cjs|ssm:|GH_TOKEN|schedule:/);
});

test('retirement rejects missing or invalid grace periods before accessing any credentials',async()=>{
 for(const retire_after of [undefined,'invalid','']) await assert.rejects(retire({phase:'promoted',retire_after}),/INVALID_RETIREMENT_TIME/);
 await assert.rejects(retire({phase:'prepared'}),/ROTATION_NOT_PROMOTED/);
 await assert.rejects(retire({phase:'promoted',retire_after:new Date(Date.now()+60000).toISOString()}),/OLD_LAMBDA_INVOCATIONS/);
});

test('the recovery journal fits Standard Parameter Store without dropping recovery credentials',()=>{
 const data={phase:'prepared',entries:Object.fromEntries(Object.keys(PROFILES).map(p=>[p,{old:{DATABASE_URL:'postgres://old:old-password@db/neondb'},next:{DATABASE_URL:'postgres://new:new-password@db/neondb'}}]))};
 const encoded=encodeJournal(data);
 assert.ok(Buffer.byteLength(encoded)<=4096);
 assert.deepEqual(decodeJournal(JSON.parse(encoded)),data);
 assert.throws(()=>decodeJournal({format:'unknown'}));
});

test('retirement accepts only the expected purpose lineage, including stable legacy owners',()=>{
 assert.equal(retirementRole('migration','videoq_migrate_20260918'),'videoq_migrate_20260918');
 assert.equal(retirementRole('api','videoq_app_20260918'),'videoq_app_20260918');
 assert.throws(()=>retirementRole('api','videoq_worker_20261014'));
 assert.throws(()=>retirementRole('migration','neondb_owner'));
});
test('PR Terraform checks cannot read production state or inherit secret-reading identities',()=>{
 const workflow=readFileSync('.github/workflows/terraform-plan.yml','utf8');
 assert.doesNotMatch(workflow,/id-token: write|secrets\.[A-Z_]+|configure-aws-credentials|terraform init -input/);
 const ci=readFileSync('.github/workflows/ci.yml','utf8').split('\n  terraform-checks:\n')[1].split('\n  terraform-result:\n')[0];
 assert.doesNotMatch(ci,/id-token: write|secrets: inherit|pull-requests: write/);
 const trust=JSON.parse(readFileSync('infra/iam/videoq-github-actions-plan-trust.json','utf8'));
 assert.deepEqual(trust.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'],['repo:videoq-jp@349188820/videoq@1083911938:ref:refs/heads/main']);
 const policy=JSON.parse(readFileSync('infra/iam/videoq-neon-plan-deny.json','utf8'));
 assert.ok(policy.Statement.some(s=>s.Effect==='Deny'&&s.Action==='ssm:GetParametersByPath'&&s.Resource==='*'));
 assert.ok(policy.Statement.some(s=>s.Effect==='Deny'&&s.Action.includes('ssm:GetParameterHistory')));
});

test('recovery guards retain credentials until the rollback grace period and verification',async()=>{
 await assert.rejects(rollback(null),/NO_RECOVERABLE_ROTATION/);
 await assert.rejects(rollback({phase:'complete'}),/NO_RECOVERABLE_ROTATION/);
 await assert.rejects(finishRollback({phase:'rollback_pending',rollback_after:'invalid'}),/INVALID_ROLLBACK_PHASE/);
 await assert.rejects(finishRollback({phase:'rollback_pending',rollback_after:new Date(Date.now()+60000).toISOString()}),/ROLLBACK_INVOCATIONS/);
 assert.throws(()=>completeRollback({phase:'rollback_pending'}),/ROLLBACK_NOT_RETIRED/);
});

test('DB rotation refreshes all three consumers and waits for the longest timeout', async () => {
 const filename=resolve('.github/scripts/neon-admin.cjs'), nativeRequire=createRequire(filename);
 const calls=[];
 const fakeRequire=name=>name==='node:child_process'?{execFileSync:(_command,args)=>{
  const input=JSON.parse(readFileSync(args.at(-1).slice('file://'.length),'utf8'));
  calls.push([args[1],input]);
  if(args[1]==='update-function-configuration')return '{}';
  return JSON.stringify({LastUpdateStatus:'Successful',RevisionId:'revision',
   Timeout: input.FunctionName.includes('account')?300:900,
   Environment:{Variables:{DB_PARAM_NAME:PROFILES.worker.parameter,KEEP:'unchanged'}}});
 }}:nativeRequire(name);
 const module={exports:{}};
 runInNewContext(readFileSync(filename,'utf8'),{require:fakeRequire,module,__dirname:resolve('.github/scripts'),
  process:{env:{}},console,URL,Buffer,Date});
 assert.equal(await module.exports.refreshLambda('new-generation'),900);
 const updates=calls.filter(([command])=>command==='update-function-configuration').map(([,input])=>input);
 assert.deepEqual(updates.map(input=>input.FunctionName),['videoq-worker-prod','videoq-worker-search-prod','videoq-worker-account-prod']);
 for(const update of updates){
  assert.equal(update.Environment.Variables.DB_CREDENTIAL_GENERATION,'new-generation');
  assert.equal(update.Environment.Variables.KEEP,'unchanged');
  assert.equal(update.RevisionId,'revision');
 }
});
