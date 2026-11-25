// Explicit state-only adoption after a metadata-only maintenance deployment.
// Provider imports run against a private local copy. Remote ownership is changed
// once, with Terraform's serial/lineage check and an immutable recovery snapshot.
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const {archiveState}=require('../../infra/bin/terraform-r2.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39',WORKER='3dcc0f4ac330413d970b5da7eadec8ea';
const VERSION='module.release.cloudflare_worker_version.release',DEPLOYMENT='module.release.cloudflare_workers_deployment.active';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function equivalentVersion(before,after){
 const a=before?.resources,b=after?.resources;
 if(!a?.script?.etag||a.script.etag!==b?.script?.etag||!isDeepStrictEqual(a.script_runtime,b.script_runtime))throw Error('RECONCILE_CODE_OR_RUNTIME_CHANGED');
 const bindings=v=>[...(v.bindings??[])].sort((x,y)=>x.name.localeCompare(y.name));
 if(!Array.isArray(a.bindings)||!Array.isArray(b.bindings)||!isDeepStrictEqual(bindings(a),bindings(b)))throw Error('RECONCILE_BINDINGS_CHANGED');
 const traffic=b.bindings.filter(v=>v.name==='MIGRATION_TRAFFIC_STATE');
 if(traffic.length!==1||traffic[0].type!=='plain_text'||traffic[0].text!=='running')throw Error('RECONCILE_RUNNING_TRAFFIC_REQUIRED');
 // Cloudflare changes its computed trigger when PATCH creates a version.
 // Retain every user/source annotation; ignore only this provider-owned field.
 const annotations=v=>Object.fromEntries(Object.entries(v.annotations??{}).filter(([key])=>key!=='workers/triggered_by'));
 if(!isDeepStrictEqual(annotations(before),annotations(after)))throw Error('RECONCILE_SOURCE_ANNOTATIONS_CHANGED');
}
function stateResources(state){
 if(!state?.lineage||!Number.isSafeInteger(state.serial)||!Array.isArray(state.resources)||state.resources.length!==2)throw Error('RECONCILE_UNEXPECTED_STATE');
 const get=type=>{const r=state.resources.filter(v=>v.module==='module.release'&&v.type===type);if(r.length!==1||r[0].instances?.length!==1||r[0].instances[0].deposed)throw Error('RECONCILE_UNEXPECTED_STATE');return r[0].instances[0].attributes;};
 return{version:get('cloudflare_worker_version'),deployment:get('cloudflare_workers_deployment')};
}
async function main({env=process.env,run=spawnSync,fetcher=fetch,archive=archiveState}={}){
 const expected=env.EXPECTED_STATE_VERSION,active=env.EXPECTED_ACTIVE_VERSION,deployment=env.EXPECTED_ACTIVE_DEPLOYMENT;
 if(![expected,active,deployment].every(v=>uuid.test(v??''))||expected===active)throw Error('RECONCILE_EXPLICIT_IDENTITIES_REQUIRED');
 const root=path.resolve(__dirname,'../..'),remote=path.join(root,'infra/cloudflare-releases/api');
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'videoq-state-adoption-'));
 function tf(directory,args){const result=run(process.execPath,[path.join(root,'infra/bin/terraform-r2.cjs'),'-chdir='+directory,...args],{env,encoding:'utf8',maxBuffer:96*1024*1024});if(result.status!==0)throw Error('RECONCILE_TERRAFORM_FAILED');return result.stdout;}
 async function api(suffix){const r=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/videoq-api/${suffix}`,{headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN},redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('RECONCILE_READ_FAILED');const d=await r.json();if(!d.success)throw Error('RECONCILE_READ_FAILED');return d.result;}
 async function assertLive(){const d=(await api('deployments')).deployments?.[0];if(d?.id!==deployment||d.versions?.length!==1||d.versions[0].version_id!==active||d.versions[0].percentage!==100)throw Error('RECONCILE_ACTIVE_DEPLOYMENT_CHANGED');}
 try{
  tf(remote,['init','-lockfile=readonly','-input=false']);
  const originalText=tf(remote,['state','pull']),original=JSON.parse(originalText),owned=stateResources(original);
  if(owned.version.id===active&&owned.deployment.id===deployment){await assertLive();console.log('API release state already reconciled.');return;}
  if(owned.version.id!==expected||owned.version.worker_id!==WORKER||owned.deployment.script_name!=='videoq-api'||owned.deployment.versions?.length!==1||owned.deployment.versions[0].version_id!==expected||owned.deployment.versions[0].percentage!==100)throw Error('RECONCILE_STATE_IDENTITY_CHANGED');
  await assertLive();equivalentVersion(await api('versions/'+expected),await api('versions/'+active));
  // No remote backend in this temporary root; imports cannot change remote state.
  fs.writeFileSync(path.join(work,'main.tf.json'),JSON.stringify({terraform:{required_version:'>= 1.15.1, < 2.0',required_providers:{cloudflare:{source:'cloudflare/cloudflare',version:'~> 5.29.0'}}},provider:{cloudflare:{}},variable:{release:{type:'any',default:{}}},module:{release:{source:path.join(root,'infra/modules/cloudflare-release'),account_id:ACCOUNT,worker_id:WORKER,script_name:'videoq-api',release:'${var.release}'}}}),{mode:0o600});
  fs.copyFileSync(path.join(remote,'.terraform.lock.hcl'),path.join(work,'.terraform.lock.hcl'));
  fs.writeFileSync(path.join(work,'terraform.tfstate'),originalText,{mode:0o600});
  tf(work,['init','-lockfile=readonly','-input=false']);tf(work,['validate']);
  tf(work,['state','rm',VERSION,DEPLOYMENT]);
  tf(work,['import','-input=false',VERSION,`${ACCOUNT}/${WORKER}/${active}`]);
  tf(work,['import','-input=false',DEPLOYMENT,`${ACCOUNT}/videoq-api/${deployment}`]);
  const adopted=JSON.parse(tf(work,['state','pull'])),next=stateResources(adopted);
  if(adopted.lineage!==original.lineage||adopted.serial<=original.serial||next.version.id!==active||next.deployment.id!==deployment||next.deployment.versions?.length!==1||next.deployment.versions[0].version_id!==active||next.deployment.versions[0].percentage!==100)throw Error('RECONCILE_IMPORTED_STATE_INVALID');
  if(tf(remote,['state','pull'])!==originalText)throw Error('RECONCILE_REMOTE_STATE_CHANGED');
  await assertLive();
  await archive(originalText,'videoq/prod/workers/api.tfstate',env);
  adopted.serial=original.serial+1;
  fs.writeFileSync(path.join(work,'terraform.tfstate'),JSON.stringify(adopted),{mode:0o600});
  // No force: a concurrent state write with a newer serial fails rather than
  // replacing it. The workflow also shares CD's production concurrency owner.
  tf(remote,['state','push',path.join(work,'terraform.tfstate')]);
  const verified=stateResources(JSON.parse(tf(remote,['state','pull'])));
  if(verified.version.id!==active||verified.deployment.id!==deployment)throw Error('RECONCILE_READBACK_FAILED');
  await assertLive();console.log('Reconciled API release ownership; application code and traffic were unchanged.');
 }finally{fs.rmSync(work,{recursive:true,force:true});}
}
if(require.main===module)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'RECONCILE_FAILED');process.exitCode=1;});
module.exports={equivalentVersion,stateResources,main};
