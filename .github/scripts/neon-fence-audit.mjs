// AWS-only parent. The DB child receives no AWS, OIDC, NODE_OPTIONS or PG_* input
// except the fixed read-only options below. No operation installs/releases a fence.
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,lstat,realpath,symlink,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),m=require('./neon-admin.cjs');
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const BUILD=/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-rotation-prod:[a-f0-9-]{36}$/;
const TARGET=Object.freeze({purpose:'production',host:'ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech',databaseName:'neondb',rolePrefix:'videoq_'});
const execute=promisify(execFile);
export async function ensureOperatorDependencies(root){
 const modules=join(root,'node_modules'),isolated=join(root,'.github/operations-tools/node_modules');
 try{await lstat(modules);}catch(error){if(error.code!=='ENOENT')throw error;await symlink('.github/operations-tools/node_modules',modules,'dir');}
 if(!(await lstat(modules)).isSymbolicLink()||await realpath(modules)!==await realpath(isolated))throw Error('ISOLATED_OPERATOR_DEPENDENCIES_REQUIRED');
}
function context(env){
 const run=env.MAINTENANCE_RUN_ID;
 if(env.MAINTENANCE_KIND!=='audit'||env.MAINTENANCE_STAGE!=='login-fence-audit'
  ||env.MAINTENANCE_TABLE!=='videoq-db-maintenance-prod'||! /^[a-f0-9]{32}$/.test(run||'')
  ||!BUILD.test(env.CODEBUILD_BUILD_ARN||'')
  ||env.GITHUB_ACTIONS)throw Error('AWS_FENCE_AUDIT_CONTEXT_REQUIRED');
 return {run,table:env.MAINTENANCE_TABLE,execution:'arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run};
}
function adminUrl(value){
 if(typeof value!=='string'||[...value].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw Error('INVALID_FENCE_ADMIN_CONNECTION');
 const u=new URL(value),user=decodeURIComponent(u.username);
 if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!==TARGET.host||decodeURIComponent(u.pathname.slice(1))!==TARGET.databaseName
  ||!user||user.startsWith(TARGET.rolePrefix)||!u.password||u.hash||!['','5432'].includes(u.port)
  ||[...u.searchParams.keys()].some(k=>!['sslmode','channel_binding'].includes(k))
  ||[...new Set(u.searchParams.keys())].some(k=>u.searchParams.getAll(k).length!==1))throw Error('INVALID_FENCE_ADMIN_CONNECTION');
 // Tighten the transport without changing the stored administrator credential.
 u.searchParams.set('sslmode','verify-full');return u.toString();
}
/** Injectable transports are for hermetic tests, never accepted by the broker. */
export async function runNeonFenceAudit({env=process.env,aws=m.aws,readParameter=m.readParameter,run=execute,root=ROOT}={}){
 const c=context(env),key={pk:{S:'run#'+c.run}},get=()=>aws('dynamodb','get-item',{TableName:c.table,Key:key,ConsistentRead:true});
 const row=(await get()).Item;
 if(row?.kind?.S!=='audit'||row?.inspection?.S!=='postgres-login-fence'||row?.execution_arn?.S!==c.execution)throw Error('FENCE_AUDIT_RUN_MISMATCH');
 await ensureOperatorDependencies(root);
 const [{postgresLoginFencePlanSchema},{readPrivateInput}]=await Promise.all([
  import('../../apps/api/scripts/migrations/d1/postgres-login-fence.ts'),
  import('../../apps/api/scripts/migrations/d1/private-input.ts'),
 ]);
 const validate=raw=>{const plan=postgresLoginFencePlanSchema.parse(raw);if(JSON.stringify(plan.target)!==JSON.stringify(TARGET))throw Error('FENCE_AUDIT_PLAN_TARGET_MISMATCH');return plan;};
 const summary=plan=>({prepared:true,operation_id:plan.operationId,managed_roles:plan.roles.length,catalog_sha256:plan.catalogSha256,write_fence_installed:false,production_data_changed:false});
 if(row.fence_plan){const plan=validate(JSON.parse(row.fence_plan.S));if(!BUILD.test(row.fence_audit_build_arn?.S||'')||row.fence_plan_sha256?.S!==createHash('sha256').update(JSON.stringify(plan)).digest('hex'))throw Error('FENCE_AUDIT_PLAN_READBACK_FAILED');return {...summary(plan),existing_plan_reused:true};}
 let directory;
 try{
  directory=await mkdtemp(join(tmpdir(),'videoq-fence-audit-'));await chmod(directory,0o700);
  const target=join(directory,'target.json'),state=join(directory,'neon-login-fence-plan.json');
  await writeFile(target,JSON.stringify(TARGET),{mode:0o600});
  const url=adminUrl((await readParameter('/videoq/security/prod/db-admin')).DATABASE_URL);
  const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
  childEnv.VIDEOQ_FENCE_ADMIN_DATABASE_URL=url;
  childEnv.PGOPTIONS='-c default_transaction_read_only=on -c search_path=pg_catalog';
  const {stdout}=await run(process.execPath,['--import',pathToFileURL(join(root,'.github/operations-tools/node_modules/tsx/dist/loader.mjs')).href,
   join(root,'apps/api/scripts/d1-postgres-login-fence.ts'),'--mode','prepare','--target',target,'--state',state],
  {cwd:root,env:childEnv,timeout:120000,maxBuffer:65536});
  const proof=JSON.parse(stdout.trim());
  if(proof.prepared!==true||proof.purpose!=='production'||proof.writeFenceInstalled!==false||!Number.isSafeInteger(proof.roles))throw Error('FENCE_AUDIT_CHILD_NOT_VERIFIED');
  const plan=validate(JSON.parse((await readPrivateInput(state,128*1024)).toString()));
  if(plan.roles.length!==proof.roles)throw Error('FENCE_AUDIT_CHILD_NOT_VERIFIED');
  const serialized=JSON.stringify(plan),sha=createHash('sha256').update(serialized).digest('hex');
  const values={':kind':{S:'audit'},':inspection':{S:'postgres-login-fence'},':execution':{S:c.execution},':plan':{S:serialized},':sha':{S:sha},':build':{S:env.CODEBUILD_BUILD_ARN}};
  try{
   await aws('dynamodb','update-item',{TableName:c.table,Key:key,
    UpdateExpression:'SET fence_plan = :plan, fence_plan_sha256 = :sha, fence_audit_build_arn = :build',
    ConditionExpression:'#kind = :kind AND #inspection = :inspection AND execution_arn = :execution AND attribute_not_exists(fence_plan)',
    ExpressionAttributeNames:{'#kind':'kind','#inspection':'inspection'},ExpressionAttributeValues:values});
  }catch{
   // A lost successful response is reconciled by exact readback; never overwrite.
   const saved=(await get()).Item;if(saved?.fence_plan?.S!==serialized||saved?.fence_plan_sha256?.S!==sha||saved?.fence_audit_build_arn?.S!==env.CODEBUILD_BUILD_ARN)throw Error('FENCE_AUDIT_PLAN_PERSISTENCE_FAILED');
  }
  const saved=(await get()).Item;
  if(saved?.fence_plan?.S!==serialized||saved?.fence_plan_sha256?.S!==sha||saved?.fence_audit_build_arn?.S!==env.CODEBUILD_BUILD_ARN)throw Error('FENCE_AUDIT_PLAN_READBACK_FAILED');
  return {...summary(plan),existing_plan_reused:false};
 }finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length!==2)throw Error('NO_FENCE_AUDIT_ARGUMENTS_ALLOWED');console.log(JSON.stringify(await runNeonFenceAudit()));}
 catch{console.error('AWS_NEON_LOGIN_FENCE_AUDIT_FAILED');process.exitCode=1;}
}
