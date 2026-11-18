// Local operator only. One explicit action per invocation; never auto-start a
// hold, loop over steps, recover, release a lock, or print private runtime state.
const path=require('node:path'),fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {verifyReviewedSource,createGithubTransport}=require('./run-cutover-admission.cjs');
const {cloudflareToken}=require('./run-d1-resource-preflight.cjs');
const {createResourcePreflightAws,createResourceMetadataTransport,readResourcePlatform,createResourcePreflight}=require('./d1-resource-preflight.cjs');
const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');
const {createResourceAwsTransport}=require('./d1-resource-aws.cjs');
const {createResourceContextStore}=require('./d1-resource-context.cjs');
const {createPrivateResourcePlans}=require('./d1-resource-plans.cjs');
const {withLockedResourceRuntime}=require('./d1-resource-operation.cjs');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const {definition}=require('../../infra/db-maintenance/state-machine.cjs');
const ROOT=path.resolve(__dirname,'../..');
const ACTIONS=['initialize','claim','advance','complete','abort'];
function parse(args){
 if(args.length!==8)throw Error('RESOURCE_OPERATOR_ARGUMENTS_REQUIRED');const o={};
 for(let i=0;i<args.length;i+=2){if(!['--action','--run','--source','--directory'].includes(args[i])||o[args[i]]!==undefined)throw Error('RESOURCE_OPERATOR_ARGUMENTS_REQUIRED');o[args[i]]=args[i+1];}
 if(!ACTIONS.includes(o['--action'])||!/^[a-f0-9]{32}$/.test(o['--run']??'')||!/^[a-f0-9]{40}$/.test(o['--source']??'')||typeof o['--directory']!=='string'||!path.isAbsolute(o['--directory'])||o['--directory'].includes('\0'))throw Error('RESOURCE_OPERATOR_ARGUMENTS_REQUIRED');
 return{action:o['--action'],run:o['--run'],source:o['--source'],directory:o['--directory']};
}
async function main({args=process.argv.slice(2),env=process.env,root=ROOT,execute=execFileSync,fetcher=fetch}={}){
 const requested=parse(args);
 if(env.VIDEOQ_D1_RESOURCE_OPERATOR!=='true')throw Error('RESOURCE_OPERATOR_DISABLED');
 if(env.GITHUB_ACTIONS||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL||env.VIDEOQ_AWS_CLI||fs.realpathSync(root)!==fs.realpathSync(ROOT))throw Error('RESOURCE_OPERATOR_LOCAL_CONTEXT_REQUIRED');
 // Before credential discovery, local publication, or any remote mutation.
 await verifyReviewedSource({source:requested.source,root,execute,env});
 const {run,source,directory,action}=requested;
 const store=await createResourceContextStore({directory,aws:createResourceAwsTransport({run,source,env,root})});
 // A resume never regenerates a missing capability, even before authentication.
 const prior=action==='initialize'?null:await store.loadRequired({run,source});
 const token=cloudflareToken({execute,env,root});
 const metadataAws=createResourcePreflightAws({execute,env,root}),metadataCf=createResourceMetadataTransport(token,{fetcher});
 const actual=await readResourcePlatform({aws:metadataAws,cloudflare:metadataCf});
 if(actual.reviewedSource!==source)throw Error('RESOURCE_OPERATOR_REVIEWED_BUNDLE_REQUIRED');
 const definitionSha256=resourceDigest(definition({neonRetired:true,table:'videoq-db-maintenance-prod',projects:Object.fromEntries(['rotation','migration','backup','smoke','audit','deploy'].map(k=>[k,'videoq-db-'+k+'-prod']))}));
 if(action==='initialize'){
  const saved=await store.initialize({run,source,definitionSha256,projectSha256:actual.projectSha256,platformSha256:actual.platformSha256});
  return{action,run,source,initialized:true,created:saved.created,remoteMutation:false};
 }
 if(prior.definitionSha256!==definitionSha256||prior.projectSha256!==actual.projectSha256||prior.platformSha256!==actual.platformSha256)throw Error('RESOURCE_OPERATOR_CONTEXT_DRIFT');
 const plans=await createPrivateResourcePlans(directory);
 const aws=createResourceAwsTransport({run,source,executorSha256:resourceDigest({executorToken:prior.executorToken}),definitionSha256,plans,mutationsEnabled:true,env,root});
 const preflight=createResourcePreflight({source,expectedProjectSha256:prior.projectSha256,aws:metadataAws,cloudflare:metadataCf,execute,env,root});
 const assertRuntime=async input=>{
  const current=await store.loadRequired({run,source});
  if(resourceDigest(current)!==resourceDigest(prior))throw Error('RESOURCE_OPERATOR_CONTEXT_DRIFT');
  const observed=await preflight(input);
  if(observed.platformSha256!==prior.platformSha256)throw Error('RESOURCE_OPERATOR_CONTEXT_DRIFT');
 };
 // Scope-limited existing transports; no application/PG credential retrieval.
 const outcome=await withLockedResourceRuntime({enabled:true,run,source,directory,executorToken:prior.executorToken,definitionSha256,token,plans,aws,
  lambda:(command,input)=>aws('lambda',command,input),
  github:createGithubTransport({execute,env,root}),cloudflare:createCloudflareTrafficTransport(token,{fetcher}),assertRuntime,
  python:env.VIDEOQ_RESOURCE_PYTHON??'python3',
 },runtime=>runtime[action]());
 // Never serialize provider responses, private plans, capabilities, or SQL.
 const summary={action,run,source,invocationFinished:true};
 if(typeof outcome?.status==='string'&&/^[a-z-]{1,40}$/.test(outcome.status))summary.status=outcome.status;
 for(const field of ['step','restored'])if(typeof outcome?.[field]==='string'&&/^[a-z-]{1,40}$/.test(outcome[field]))summary[field]=outcome[field];
 return summary;
}
module.exports={parse,main};
if(require.main===module)main().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error('RESOURCE_OPERATOR_FAILED: preserve the existing hold and private directory; no automatic recovery, retry or release was attempted.');process.exitCode=1;});
