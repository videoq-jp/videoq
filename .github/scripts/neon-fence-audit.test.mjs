import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {runNeonFenceAudit} from './neon-fence-audit.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),RUN='a'.repeat(32);
async function fixture(options={}){
 const directory=await mkdtemp(join(tmpdir(),'videoq-fence-audit-unit-'));await mkdir(join(directory,'.github/operations-tools'),{recursive:true});
 await symlink(join(root,'.github/operations-tools/node_modules'),join(directory,'.github/operations-tools/node_modules'),'dir');
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'C',MAINTENANCE_KIND:'audit',MAINTENANCE_STAGE:'login-fence-audit',MAINTENANCE_TABLE:'videoq-db-maintenance-prod',MAINTENANCE_RUN_ID:RUN,
 CODEBUILD_BUILD_ARN:'arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-rotation-prod:01234567-89ab-cdef-0123-456789abcdef',AWS_ACCESS_KEY_ID:'synthetic-parent-only',AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:'/parent',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'parent-oidc',NODE_OPTIONS:'--require parent-only',PGPASSWORD:'parent-password'};
 const role={oid:42,name:'videoq_api_test',can_login:true,superuser:false,create_db:false,create_role:false,replication:false,bypass_rls:false,inherit:true,connection_limit:-1,valid_until:null};
 const plan={version:1,operationId:randomUUID(),target:{purpose:'production',host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech',databaseName:'neondb',rolePrefix:'videoq_'},roles:[role],memberships:[],catalogSha256:createHash('sha256').update(JSON.stringify({roles:[{...role,can_login:null}],memberships:[]})).digest('hex')};
 let item={kind:{S:'audit'},inspection:{S:'postgres-login-fence'},execution_arn:{S:'arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+RUN}},state;
 const calls=[];
 const aws=async(service,command,value)=>{
  calls.push({service,command,value});assert.equal(service,'dynamodb');
  if(command==='get-item')return {Item:structuredClone(item)};
  assert.equal(command,'update-item');assert.match(value.ConditionExpression,/attribute_not_exists\(fence_plan\)/);
  assert.equal(value.ExpressionAttributeValues[':execution'].S,item.execution_arn.S);
  item={...item,fence_plan:value.ExpressionAttributeValues[':plan'],fence_plan_sha256:value.ExpressionAttributeValues[':sha'],fence_audit_build_arn:value.ExpressionAttributeValues[':build']};
  if(options.lostWrite)throw Error('synthetic lost response');return {};
 };
 const url=options.url??'postgresql://neondb_owner:synthetic-only-password@ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
 let fetched=0,executed=0;
 const readParameter=async name=>{assert.equal(name,'/videoq/security/prod/db-admin');fetched++;return {DATABASE_URL:url};};
 const run=async(command,args,opts)=>{
  executed++;assert.equal(command,process.execPath);assert.equal(args[args.indexOf('--mode')+1],'prepare');
  assert.equal(args.includes(url),false);assert.equal(opts.env.VIDEOQ_FENCE_ADMIN_DATABASE_URL.includes('sslmode=verify-full'),true);
  for(const key of Object.keys(opts.env))assert.ok(['PATH','HOME','TMPDIR','LANG','VIDEOQ_FENCE_ADMIN_DATABASE_URL','PGOPTIONS'].includes(key),key);
  assert.equal(opts.env.PGOPTIONS,'-c default_transaction_read_only=on -c search_path=pg_catalog');
  assert.deepEqual(JSON.parse(await readFile(args[args.indexOf('--target')+1],'utf8')),plan.target);
  state=args[args.indexOf('--state')+1];await writeFile(state,JSON.stringify(options.badPlan?{...plan,DATABASE_URL:url}:plan),{mode:0o600});
  return {stdout:JSON.stringify({prepared:true,purpose:'production',roles:1,writeFenceInstalled:false})};
 };
 return {directory,env,calls,plan,get fetched(){return fetched;},get executed(){return executed;},get state(){return state;},args:{env,aws,readParameter,run,root:directory},changeItem(fn){item=fn(item);},async close(){await rm(directory,{recursive:true,force:true});}};
}
test('AWS audit strips credentials from the fixed prepare-only child and persists an immutable verified plan',async()=>{
 const f=await fixture();try{
  const result=await runNeonFenceAudit(f.args);assert.equal(result.prepared,true);assert.equal(result.write_fence_installed,false);assert.equal(result.production_data_changed,false);assert.equal(result.managed_roles,1);assert.equal(result.existing_plan_reused,false);
  assert.equal(f.calls.filter(x=>x.command==='update-item').length,1);assert.equal(f.fetched,1);assert.equal(f.executed,1);
  assert.equal(JSON.stringify(f.calls).includes('synthetic-only-password'),false);
  await assert.rejects(access(dirname(f.state)));
  assert.equal((await runNeonFenceAudit(f.args)).existing_plan_reused,true);assert.equal(f.fetched,1);assert.equal(f.executed,1);
 }finally{await f.close();}
});
test('a lost DynamoDB write response is reconciled by exact immutable readback',async()=>{
 const f=await fixture({lostWrite:true});try{assert.equal((await runNeonFenceAudit(f.args)).prepared,true);assert.equal(f.calls.filter(c=>c.command==='update-item').length,1);await assert.rejects(access(dirname(f.state)));}finally{await f.close();}
});
test('wrong job/run context and unsafe administrator destinations never reach a DB child',async()=>{
 for(const change of [{MAINTENANCE_KIND:'rotate'},{MAINTENANCE_STAGE:'install'},{GITHUB_ACTIONS:'true'},{CODEBUILD_BUILD_ARN:'untrusted'}]){
  const f=await fixture();try{await assert.rejects(runNeonFenceAudit({...f.args,env:{...f.env,...change}}),/CONTEXT_REQUIRED/);assert.equal(f.fetched,0);assert.equal(f.calls.length,0);}finally{await f.close();}
 }
 for(const url of ['postgresql://neondb_owner:synthetic@attacker.invalid/neondb?sslmode=require','postgresql://videoq_api_test:synthetic@ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech/neondb','postgresql://neondb_owner:synthetic@ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech/neondb?options=-c%20role%3Dother']){
  const f=await fixture({url});try{await assert.rejects(runNeonFenceAudit(f.args),/INVALID_FENCE_ADMIN_CONNECTION/);assert.equal(f.executed,0);assert.equal(f.calls.filter(c=>c.command==='update-item').length,0);}finally{await f.close();}
 }
 const f=await fixture();try{f.changeItem(row=>({...row,inspection:{S:'ordinary-age-audit'}}));await assert.rejects(runNeonFenceAudit(f.args),/RUN_MISMATCH/);assert.equal(f.fetched,0);}finally{await f.close();}
});
test('unknown plan fields or corrupted retained plans fail without overwriting evidence',async()=>{
 const f=await fixture({badPlan:true});try{await assert.rejects(runNeonFenceAudit(f.args));assert.equal(f.calls.filter(c=>c.command==='update-item').length,0);await assert.rejects(access(dirname(f.state)));}finally{await f.close();}
 const g=await fixture();try{await runNeonFenceAudit(g.args);g.changeItem(row=>({...row,fence_plan_sha256:{S:'0'.repeat(64)}}));await assert.rejects(runNeonFenceAudit(g.args),/READBACK_FAILED/);assert.equal(g.executed,1);assert.equal(g.calls.filter(c=>c.command==='update-item').length,1);}finally{await g.close();}
});
