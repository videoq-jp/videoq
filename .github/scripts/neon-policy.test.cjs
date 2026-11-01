const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {OWNER,PROFILES,loginName,connectionUrl,encodeJournal,decodeJournal,retirementRole}=require('./neon-policy.cjs');
const {denied,retire,rollback,finishRollback,completeRollback}=require('./neon-admin.cjs');

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
 const source=readFileSync('.github/scripts/neon-rotate.cjs','utf8');
 assert.ok(source.indexOf("await smoke(journal.generation);")<source.indexOf('await retire(journal)'));
 assert.ok(source.indexOf('while(Date.now()<Date.parse(journal.retire_after))')<source.indexOf('await retire(journal)'));
 assert.ok(source.indexOf('await retire(journal)')<source.indexOf("await smoke(journal.generation+'-retired')"));
 const workflow=readFileSync('.github/workflows/neon-credentials.yml','utf8');
 assert.match(workflow,/group: production-db-maintenance/);
 assert.match(workflow,/cancel-in-progress: false/);
 assert.match(workflow,/environment: production-infra/);
 assert.match(workflow,/AWS_GITHUB_ACTIONS_NEON_ROTATION_ROLE_ARN/);
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
